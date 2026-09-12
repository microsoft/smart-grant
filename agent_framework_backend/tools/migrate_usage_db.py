"""Migra o log de uso do SQLite antigo para o log de eventos em blob.

O banco ``data/usage.db`` era local ao container: cada deploy comecava do zero
e cada replica via um historico diferente. O log em blob substitui isso. Este
script existe para que a troca nao custe o historico ja acumulado.

Uso
~~~
Inspecionar sem escrever nada (gera os arquivos em disco para conferencia)::

    python tools/migrate_usage_db.py --dry-run --out ./migracao

Gravar de fato, no mesmo destino que o backend usa (mesmas variaveis de
ambiente, mesma precedencia)::

    python tools/migrate_usage_db.py

O script se recusa a rodar se o destino ja tiver eventos nos dias que seriam
importados, porque o log e append-only: rodar duas vezes duplicaria tudo, e
nao ha como desfazer. ``--force`` ignora a checagem, e assume o risco.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import get_settings
from services.event_log import DailyEventLog, _blob_name

# A ordem importa: e a mesma de PulseTracker._record, para os arquivos gerados
# aqui serem indistinguiveis dos gravados em producao.
COLUMNS = (
    "ts",
    "event_type",
    "grant_type",
    "school_name",
    "district",
    "state",
    "city",
    "school_type",
    "students",
    "grade_levels",
    "selected_grant_title",
    "selected_funder",
    "amount_low",
    "amount_high",
)


def read_events(db: Path) -> list[dict]:
    """Le os eventos do banco antigo, ja no formato do log.

    ``is_baseline`` fica de fora de proposito: a coluna existia para marcar
    dados semeados, nunca foi usada (0 em 86 linhas) e o painel nao a le.
    """

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"SELECT {', '.join(COLUMNS)} FROM pulse_events ORDER BY ts"
        ).fetchall()
    finally:
        conn.close()
    return [{c: row[c] for c in COLUMNS} for row in rows]


def group_by_day(events: list[dict]) -> dict[date, list[dict]]:
    grouped: dict[date, list[dict]] = defaultdict(list)
    for event in events:
        grouped[datetime.fromisoformat(event["ts"]).date()].append(event)
    return dict(sorted(grouped.items()))


def write_locally(grouped: dict[date, list[dict]], out: Path) -> None:
    for day, events in grouped.items():
        path = out / _blob_name(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            for event in events:
                fh.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
                fh.write("\n")


def build_log() -> DailyEventLog:
    settings = get_settings()
    url = settings.pulse_storage_account_url.strip()
    conn = settings.pulse_storage_connection_string.strip()
    if url:
        return DailyEventLog(url, settings.pulse_storage_container)
    if conn:
        return DailyEventLog(
            "", settings.pulse_storage_container, connection_string=conn
        )
    raise SystemExit(
        "Nenhum destino configurado. Defina PULSE_STORAGE_ACCOUNT_URL "
        "(producao) ou PULSE_STORAGE_CONNECTION_STRING (Azurite)."
    )


async def upload(grouped: dict[date, list[dict]], *, force: bool) -> int:
    log = build_log()
    try:
        existing = await log.read(None)
        colisoes = sorted(
            {
                datetime.fromisoformat(e["ts"]).date()
                for e in existing.events
                if isinstance(e.get("ts"), str)
            }
            & set(grouped)
        )
        if colisoes and not force:
            dias = ", ".join(d.isoformat() for d in colisoes)
            print(
                f"Abortado: o destino ja tem eventos em {dias}.\n"
                "O log e append-only; importar de novo duplicaria o historico. "
                "Use --force se souber o que esta fazendo."
            )
            return 1

        gravados = 0
        for day, events in grouped.items():
            for event in events:
                await log.append(datetime.fromisoformat(event["ts"]), event)
                gravados += 1
            print(f"  {_blob_name(day)}  {len(events):>3} eventos")
        print(f"\n{gravados} eventos importados.")
    finally:
        await log.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "data" / "usage.db",
        help="banco SQLite de origem",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="nao escreve no blob; grava os arquivos em --out para conferencia",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("./migracao"), help="destino do --dry-run"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="importa mesmo que o destino ja tenha eventos nesses dias",
    )
    args = parser.parse_args()

    if not args.db.exists():
        print(f"Banco nao encontrado: {args.db}")
        return 1

    events = read_events(args.db)
    if not events:
        print("Nada a migrar: o banco esta vazio.")
        return 0

    grouped = group_by_day(events)
    print(
        f"{len(events)} eventos em {len(grouped)} dias, "
        f"de {min(grouped)} a {max(grouped)}."
    )

    if args.dry_run:
        write_locally(grouped, args.out)
        print(f"Arquivos gravados em {args.out.resolve()} (nada foi enviado).")
        return 0

    return asyncio.run(upload(grouped, force=args.force))


if __name__ == "__main__":
    raise SystemExit(main())
