"""Testes das rotas de servico, da configuracao e do contexto da escola."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from config import GRANT_TYPES, get_settings
from main import app
from services.grants import Grant
from v2.school import SchoolData, format_school_context

# ============================================================================
# Configuration Tests
# ============================================================================

class TestConfig:
    """Test configuration module."""
    
    def test_grant_types_exist(self):
        """Verify all expected grant types are defined."""
        expected = ['stem', 'cte', 'special-ed', 'arts', 'literacy']
        for grant_type in expected:
            assert grant_type in GRANT_TYPES
    
    def test_grant_type_structure(self):
        """Verify grant type structure."""
        for info in GRANT_TYPES.values():
            assert 'name' in info
            assert 'amount' in info
            assert 'deadline' in info
    
    def test_settings_singleton(self):
        """Verify settings returns same instance."""
        s1 = get_settings()
        s2 = get_settings()
        assert s1 is s2


# ============================================================================
# Grant Service Tests
# ============================================================================

class TestGrantServices:
    """Test grant data services."""
    
    def test_grant_dataclass(self):
        """Test Grant dataclass creation."""
        grant = Grant(
            id="test-123",
            title="Test STEM Grant",
            agency="Department of Education",
            amount="$100,000 - $250,000",
            deadline=datetime(2024, 12, 31, tzinfo=UTC),
            type="Discretionary",
            focus=["STEM", "Technology"],
            eligibility=["K-12 Public Schools"],
            match_required=False,
            difficulty="Medium",
            success_rate=35,
            estimated_hours=40,
            description="Funds STEM equipment and teacher training.",
            source="test"
        )
        
        assert grant.id == "test-123"
        assert grant.title == "Test STEM Grant"
        assert len(grant.focus) == 2
    
    def test_format_school_context_none(self):
        """Without school data the context must refuse, not invent a placeholder.

        A friendly fallback like "Your School" would be silently fed to the
        model and invite fabricated enrolment and demographics.
        """
        result = format_school_context(None)
        assert result.startswith("ERROR:")
        assert "do not fabricate" in result
    
    def test_format_school_context_with_data(self):
        """Test formatting with school data."""
        school = SchoolData(
            id="123",
            name="Lincoln High",
            district="LAUSD",
            city="Los Angeles",
            state="CA",
            zip="90001",
            students=2500,
            grades="9-12",
            type="Public",
            demographics={"freeReducedLunch": 65, "minorityEnrollment": 78},
            programs={"stem": True, "titleI": True, "cte": False, "specialEd": False},
            contact={"phone": "555-1234", "website": ""}
        )
        
        result = format_school_context(school)
        assert "Lincoln High" in result
        assert "2,500 students" in result
        # The percentage is on record; the count is arithmetic from enrolment
        # (65% of 2,500 = 1,625) so agents can cite a concrete figure.
        assert "65% = ~1,625 students" in result
        assert "STEM program on campus: Yes" in result
        assert "Title I: Yes" in result
        # 65% sits in the 50-69 band, which is moderate need - not the
        # high-need/Title I-eligible band that starts at 70%.
        assert "Moderate-need school" in result


# ============================================================================
# API Tests
# ============================================================================

class TestAPI:
    """Test FastAPI endpoints."""
    
    @pytest.fixture
    def client(self):
        """Create test client."""
        return TestClient(app)
    
    def test_root_endpoint(self, client):
        """Test root endpoint returns API info."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert "service" in data
        assert "version" in data
        assert data["status"] == "healthy"
    
    def test_health_endpoint(self, client):
        """Test health check endpoint."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
    
    def test_grant_types_endpoint(self, client):
        """Test grant types listing."""
        response = client.get("/grants/types")
        assert response.status_code == 200
        data = response.json()
        assert "types" in data
        assert len(data["types"]) > 0
        
        # Check structure
        for grant_type in data["types"]:
            assert "key" in grant_type
            assert "name" in grant_type
            assert "amount" in grant_type

    def test_root_endpoint_only_advertises_live_routes(self, client):
        """A raiz e a primeira coisa que alguem le; nao pode listar rota morta.

        O pipeline legado /workflow/run foi removido. Conferimos contra o
        schema OpenAPI -- nao por requisicao, que arrastaria chamadas de rede
        reais para dentro dos testes.

        A fonte e o OpenAPI, e nao ``app.routes``, de proposito: a partir do
        FastAPI 0.138 o ``include_router`` deixa de copiar as rotas para
        ``app.routes`` e passa a guardar o router inteiro num unico objeto
        interno. As rotas continuam respondendo, mas somem da lista. Uma
        versao anterior deste teste lia ``app.routes`` e acusou o /v2 inteiro
        de ter desaparecido quando na verdade so a estrutura interna mudou.
        O OpenAPI e o contrato publicado -- e o que o cliente enxerga.
        """
        # /docs, /redoc e /openapi.json existem como rota mas nao aparecem no
        # schema; por isso a uniao com a tabela de rotas de primeiro nivel.
        registradas = set(app.openapi()["paths"])
        registradas |= {getattr(rota, "path", None) for rota in app.routes}
        anunciadas = client.get("/").json()["endpoints"]
        assert anunciadas
        faltando = set(anunciadas) - registradas
        # A lista do que existe vai junto: sem ela, uma falha so diz que algo
        # sumiu, e a investigacao comeca do zero em outra maquina.
        assert not faltando, (
            f"a raiz anuncia rotas que o app nao registrou: {sorted(faltando)}\n"
            f"registradas: {sorted(p for p in registradas if p)}"
        )


# ============================================================================
# Run tests
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
