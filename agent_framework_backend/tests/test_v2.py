"""
Unit tests for the v2 backend.

These tests are deliberately *self-contained* — they exercise the v2
package without needing real Azure credentials. A fake SDK chat client
yields canned streaming chunks so the workflow, router, telemetry, and
SSE adapters can be verified end-to-end.

Run with:
    pytest agent_framework_backend/tests/test_v2.py -q
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest

if TYPE_CHECKING:
    from v2.workflow import GenerationWorkflow

from v2.events import EventType, WorkflowEvent
from v2.router import ModelRouter, UnknownModelKeyError
from v2.schemas import (
    ApplicationOutput,
    BudgetOutput,
    ComplianceOutput,
    DiscoveryOutput,
    FoundationProspect,
    IntelligenceOutput,
    NarrativeOutput,
)
from v2.settings import V2Settings
from v2.streaming import to_json_sse
from v2.telemetry import agent_span, estimate_cost_usd
from v2.usage import Usage

# --------------------------------------------------------------------- schemas


def test_schemas_round_trip() -> None:
    """All Pydantic schemas accept their documented payload."""

    DiscoveryOutput(summary="hi")
    NarrativeOutput(
        needs_assessment="x",
        theory_of_change="y",
        target_population_summary="z",
    )
    BudgetOutput(total_usd=100.0, lines=[])
    ComplianceOutput(overall_status="pass", score_percent=95, findings=[])
    IntelligenceOutput(
        probability_band="moderate",
        base_rate_pct_range="20-35%",
        base_rate_basis="Federal STEM education discretionary awards fund roughly a quarter of applicants.",
        success_probability=28,
        competitive_advantages=[],
        risks=[],
        suggested_revisions=[],
    )
    ApplicationOutput(
        title="t",
        abstract="a",
        full_application_markdown="m",
        word_count=1,
    )


# --------------------------------------------------------------------- router


def test_router_unknown_key_raises() -> None:
    settings = V2Settings(foundry_endpoint="https://x", foundry_api_key="k")
    router = ModelRouter(settings=settings)
    with pytest.raises(UnknownModelKeyError):
        router.for_key("nonsense")


def test_router_per_agent_uses_settings() -> None:
    settings = V2Settings(
        foundry_endpoint="https://x",
        foundry_api_key="k",
        agent_model_discovery="foundry-gpt-4o",
        agent_model_writer="foundry-gpt-5.4",
    )
    router = ModelRouter(settings=settings)
    mapping = router.per_agent()
    assert mapping["discovery"] == "foundry-gpt-4o"
    assert mapping["writer"] == "foundry-gpt-5.4"


def test_default_api_version_supports_responses_api() -> None:
    """O SDK fala com a Responses API, que o Azure so habilita a partir desta
    versao. Com uma anterior o servico responde 400 em toda chamada de agente,
    entao o default nao pode regredir."""

    default = V2Settings.model_fields["foundry_api_version"].default
    assert default >= "2025-03-01-preview"


def test_landscape_aggregate_compares_aware_dates() -> None:
    """As datas do Grants.gov chegam aware por _parse_mdy. Enquanto o `now`
    deste agregador foi naive, /v2/analytics/landscape respondia 500 em toda
    chamada. O ruff nao pega o caso: `.replace(tzinfo=None)` escapa da DTZ."""

    from datetime import UTC, datetime, timedelta

    from services.analytics import GrantsLandscapeService

    fecha_em_10_dias = (datetime.now(UTC) + timedelta(days=10)).strftime("%m/%d/%Y")
    aberto_ha_5_dias = (datetime.now(UTC) - timedelta(days=5)).strftime("%m/%d/%Y")
    broad = {
        "data": {
            "hitCount": 1,
            "oppHits": [
                {
                    "id": "361008",
                    "number": "ED-TEST-001",
                    "title": "Test Opportunity",
                    "agencyName": "Department of Education",
                    "closeDate": fecha_em_10_dias,
                    "openDate": aberto_ha_5_dias,
                }
            ],
        }
    }

    payload = GrantsLandscapeService()._aggregate(broad, [])

    assert payload["totals"]["closing_within_30_days"] == 1
    assert payload["totals"]["posted_last_30_days"] == 1
    # A data fecha a meia-noite, entao o resto do dia corrente e descartado.
    assert payload["closing_soon"][0]["days_until"] in (9, 10)


def test_base_rates_declare_their_provenance() -> None:
    """A tabela ja afirmou que todo numero vinha de taxas publicadas da ED e da
    NSF, o que nao era verdade. Uma estimativa interna nao pode voltar a se
    apresentar como estatistica federal, e um grant por formula nao pode ganhar
    percentual de chance: nao existe competicao para ele."""

    from v2.prompts_generation import _FORMULA_NOT_APPLICABLE, FEDERAL_BASE_RATES

    for chave, taxa in FEDERAL_BASE_RATES.items():
        if taxa.verified:
            assert taxa.source.startswith("https://"), f"{chave} afirma ser publicado sem fonte"
        else:
            assert "estimate" in taxa.basis.lower(), f"{chave} nao se declara estimativa"
            assert "%" in taxa.pct_range

    for chave in ("title_iv_a", "formula_school_improvement"):
        assert FEDERAL_BASE_RATES[chave].pct_range == _FORMULA_NOT_APPLICABLE


def test_intelligence_prompt_flags_unverified_rates() -> None:
    """O prompt precisa carregar a procedencia; sem isso o agente volta a
    atribuir a estimativa interna a uma agencia federal."""

    from v2.prompts_generation import build_intelligence_user_prompt

    prompt = build_intelligence_user_prompt(
        selected_grant=None,  # cai no bucket "fallback", que e estimativa
        school_context="Escola X",
        typed_outputs={},
        raw_outputs={},
    )

    assert "INTERNAL PLANNING ESTIMATE" in prompt
    assert "Do NOT attribute it" in prompt


def test_intelligence_probability_may_be_absent() -> None:
    """Um grant por formula nao tem competicao, entao nao ha chance de vitoria a
    exibir. O campo aceita null e o validador nao pode reescreve-lo."""

    saida = IntelligenceOutput(
        probability_band="moderate",
        base_rate_pct_range="not applicable - formula grant",
        base_rate_basis="Formula grant allocated through the state.",
        competitive_advantages=["a"],
        risks=["b"],
        suggested_revisions=["c"],
    )

    assert saida.success_probability is None


def test_generation_requires_exactly_one_target() -> None:
    """Edital e fundacao produzem documentos diferentes: um e candidatura a uma
    RFP, o outro e carta de intencao a um prospecto sem prazo nem rubrica.
    Aceitar os dois, ou nenhum, deixaria a escolha para o prompt."""

    from pydantic import ValidationError

    from routes.v2_routes import V2GenerateRequest
    from v2.schemas import FoundationProspect

    fundacao = FoundationProspect(
        id="f1",
        name="Example Family Foundation",
        focus="K-12 education",
        ein="12-3456789",
        url="https://projects.propublica.org/nonprofits/organizations/123456789",
    )

    pedido = V2GenerateRequest(grantType="stem", selectedFoundation=fundacao)
    assert pedido.selectedGrant is None

    with pytest.raises(ValidationError):
        V2GenerateRequest(grantType="stem")


def test_foundation_target_never_claims_a_deadline_or_rubric() -> None:
    """A fundacao vem do Form 990, nao de um edital publicado."""

    from v2.prompts_generation import _format_target
    from v2.schemas import FoundationProspect

    fundacao = FoundationProspect(
        id="f1",
        name="Example Family Foundation",
        focus="K-12 education",
        ein="12-3456789",
        url="https://projects.propublica.org/nonprofits/organizations/123456789",
    )

    bloco = _format_target(None, fundacao)

    assert "Example Family Foundation" in bloco
    assert "LETTER OF INQUIRY" in bloco
    assert "no published deadline" in bloco
    assert "TARGET GRANT" not in bloco


def test_search_keywords_keep_the_user_words() -> None:
    """Havia uma tabela que trocava o pedido por um termo generico: quem pedia
    laboratorio de informatica buscava 'education grant' e recebia Title X
    Family Planning. Medido na API, usar as palavras do pedido derrubou o ruido
    de 5 em 10 para 1 em 10."""

    from v2.workflow import _extract_keywords

    termos = _extract_keywords("computer science lab")
    assert "computer" in termos
    assert "science" in termos
    assert termos != "education grant"

    # A tabela casava por substring: 'ap' dentro de 'landscape' virava
    # 'advanced placement grant'.
    assert "advanced placement" not in _extract_keywords("landscape design for the courtyard")

    # Sem ancora de ensino a busca federal devolve pesquisa e defesa.
    assert "education" in _extract_keywords("3d printers")

    assert _extract_keywords("") == "K-12 education"
    assert _extract_keywords("the grants funding") == "K-12 education"

    # Palavras de ligacao diluem a consulta federal sem acrescentar sinal.
    assert _extract_keywords("computer science for all our students") == (
        "computer science students"
    )


def test_propublica_404_means_zero_results_not_failure() -> None:
    """A ProPublica responde 404 com um JSON valido de total_results 0 quando a
    busca nao acha nada. Tratar isso como excecao acusava estados inteiros de
    quebrados no log e escondia falhas reais no meio do ruido."""

    import httpx

    from services.foundations import FoundationsService

    vazio = httpx.Response(
        404,
        json={"total_results": 0, "organizations": [], "num_pages": 0},
        request=httpx.Request("GET", "https://example.test"),
    )
    assert asyncio.run(FoundationsService._read(vazio))["total_results"] == 0

    # Um 404 que nao seja da API continua sendo erro.
    quebrado = httpx.Response(
        404,
        text="<html>not found</html>",
        request=httpx.Request("GET", "https://example.test"),
    )
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(FoundationsService._read(quebrado))


def test_award_amounts_are_never_invented() -> None:
    """O parser do search2 fixava 50k-500k em TODO edital, e esse valor falso
    ainda alimentava o criterio de award-size do ranking. Sem valor publicado,
    o campo tem de dizer isso."""

    from datetime import UTC, datetime

    from services.grants import Grant, GrantsGovService

    def grant(**kw: object) -> Grant:
        base = {
            "id": "grants-gov-1",
            "title": "t",
            "agency": "a",
            "amount": "",
            "deadline": datetime.now(UTC),
            "type": "Federal",
            "focus": [],
            "eligibility": [],
            "match_required": False,
            "estimated_hours": 1,
            "difficulty": "Medium",
            "success_rate": 0,
            "description": "d",
            "source": "grants.gov",
        }
        base.update(kw)
        return Grant(**base)  # type: ignore[arg-type]

    formatar = GrantsGovService._format_amount
    assert formatar(grant()) == "Award amount not published"
    assert formatar(grant(award_floor_usd=1000, award_ceiling_usd=5000)) == "$1,000 - $5,000"
    assert formatar(grant(award_ceiling_usd=5000)) == "Up to $5,000"
    assert formatar(grant(estimated_funding_usd=90000)) == "$90,000 total program funding"


def test_search_asks_grants_gov_only_for_what_a_district_can_apply_to() -> None:
    """Sem o filtro de elegibilidade, a busca trazia editais de universidade.

    Numa execucao real (Lincoln High School, STEM) vieram 26 candidatos e o
    ranqueador desqualificou 25 -- 12 por "higher ed only", 7 por "eligibility
    not school-based", mais SBIR e programas de pos-graduacao. As recusas
    estavam corretas; a pergunta feita ao Grants.gov e que estava errada.

    O teste fixa o parametro no corpo da requisicao porque e invisivel na
    resposta: se alguem o remover, a unica consequencia observavel seria o
    ranqueador voltar a descartar quase tudo -- longe daqui, e sem explicacao.
    """

    from typing import Self

    import httpx

    from services.grants import GrantsGovService

    enviado: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"data": {"oppHits": []}}

    class FakeClient:
        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def post(self, url: str, json: dict, headers: dict) -> FakeResponse:
            enviado.update(json)
            return FakeResponse()

    original = httpx.AsyncClient
    httpx.AsyncClient = lambda *a, **k: FakeClient()  # type: ignore[assignment,misc]
    try:
        asyncio.run(GrantsGovService()._search_opportunities_api("stem", 25))
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]

    assert enviado.get("eligibilities") == "05", (
        "o search2 precisa ser filtrado por 'Independent school districts'; "
        f"foi enviado {enviado!r}"
    )
    # O filtro de status continua junto: um edital fechado nao serve para nada.
    assert enviado.get("oppStatuses") == "forecasted|posted"


def test_usd_sentinels_do_not_become_amounts() -> None:
    """O aviso usa 'none' e 0 para 'nao publicado'; se virassem numero, a
    ferramenta anunciaria um teto de premio que nao existe."""

    from services.grants import GrantsGovService

    parse = GrantsGovService._parse_usd
    assert parse(None) is None
    assert parse("none") is None
    assert parse("") is None
    assert parse(0) is None
    assert parse("1500000") == 1500000
    assert parse("$1,500,000") == 1500000


# --------------------------------------------------------------------- telemetry


def test_estimate_cost_usd_known_model() -> None:
    cost = estimate_cost_usd(
        "gpt-5.4", Usage(prompt_tokens=1000, completion_tokens=1000)
    )
    assert cost > 0


def test_estimate_cost_usd_unknown_model_returns_zero() -> None:
    assert estimate_cost_usd("does-not-exist", Usage(1000, 1000)) == 0.0


def test_agent_span_no_otel_no_op() -> None:
    with agent_span(
        agent_name="t",
        agent_index=0,
        provider="fake",
        deployment="gpt-5.4",
    ) as span:
        span.record_usage(Usage(prompt_tokens=10, completion_tokens=5))


# --------------------------------------------------------------------- streaming


def test_to_json_sse_emits_valid_json() -> None:
    import json as _json

    async def gen() -> AsyncIterator[WorkflowEvent]:
        yield WorkflowEvent(type=EventType.TOKEN, payload="hi")

    async def collect() -> list[str]:
        return [s async for s in to_json_sse(gen())]

    out = asyncio.run(collect())
    body = out[0]
    assert body.startswith("data: ")
    parsed = _json.loads(body[len("data: ") : body.index("\n\n")])
    assert parsed["type"] == "token"
    assert parsed["payload"] == "hi"


# --------------------------------------------------------------------- workflow


@dataclass
class _FakeUpdate:
    """Mimics the relevant slice of :class:`AgentResponseUpdate`."""

    text: str = ""
    usage_details: Any = None


@dataclass
class _FakeAgent:
    """Stand-in for :class:`agent_framework.Agent` used in tests.

    Implements ``run(messages, *, stream=True, ...)`` returning an async
    iterator of :class:`_FakeUpdate` objects so the workflow's executor
    code path is exercised without contacting Azure.
    """

    canned_text: str = "hello world"
    captured_prompts: list[str] = field(default_factory=list)

    def run(self, messages: Any, *, stream: bool = False, **_: Any) -> Any:
        # Mirror the SDK: when stream=True the call returns an async iterable.
        prompt = messages if isinstance(messages, str) else str(messages)
        self.captured_prompts.append(prompt)
        words = self.canned_text.split(" ")

        async def _aiter() -> AsyncIterator[_FakeUpdate]:
            for w in words:
                yield _FakeUpdate(text=w + " ")
            yield _FakeUpdate(text="", usage_details=type("U", (), {"input_token_count": 10, "output_token_count": 5})())

        if not stream:
            raise NotImplementedError("test fake only supports stream=True")
        return _aiter()


def _build_generation_workflow_with_fake_agents() -> GenerationWorkflow:
    """Build the generation workflow with its agents swapped for fakes."""

    from v2 import workflow as wf_mod
    from v2.agents import GENERATION_PIPELINE_V2, BoundAgent

    fake_agents = [
        BoundAgent(
            spec=spec,
            agent=_FakeAgent(canned_text="hello world"),  # type: ignore[arg-type]
            provider="fake",
            deployment="fake-deployment",
        )
        for spec in GENERATION_PIPELINE_V2
    ]

    with patch.object(wf_mod, "build_generation_agents", return_value=fake_agents):
        return wf_mod.GenerationWorkflow()


def test_workflow_emits_expected_event_sequence() -> None:
    """Sequencia de eventos do pipeline que a interface realmente executa.

    Cobre o estagio de geracao: cinco agentes, indices deslocados em um porque
    a Discovery ocupa o slot zero na linha do tempo do frontend.
    """

    workflow = _build_generation_workflow_with_fake_agents()

    fundacao = FoundationProspect(
        id="f1",
        name="Example Family Foundation",
        focus="K-12 education",
        ein="12-3456789",
        url="https://projects.propublica.org/nonprofits/organizations/123456789",
    )

    async def _run() -> list[WorkflowEvent]:
        return [
            ev
            async for ev in workflow.stream(
                grant_type="stem",
                custom_purpose=None,
                school_data={"name": "Test School", "state": "CA", "students": 500},
                selected_foundation=fundacao,
            )
        ]

    events = asyncio.run(_run())

    assert events[0].type is EventType.WORKFLOW_START
    assert events[-1].type is EventType.WORKFLOW_COMPLETE

    starts = [e for e in events if e.type is EventType.AGENT_START]
    completes = [e for e in events if e.type is EventType.AGENT_COMPLETE]
    assert len(starts) == 5, f"expected 5 starts, got {len(starts)}"
    assert len(completes) == 5, f"expected 5 completes, got {len(completes)}"

    tokens = [e for e in events if e.type is EventType.TOKEN]
    assert len(tokens) >= 5

    for ev in completes:
        assert isinstance(ev.payload, str)
        assert "hello" in ev.payload

    # A Discovery ocupa o slot 0; a geracao comeca no 1.
    assert min(e.agent_index for e in starts) == 1
