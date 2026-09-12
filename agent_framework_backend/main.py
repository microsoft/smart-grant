"""Ponto de entrada do backend.

A aplicacao expoe dois blocos: um punhado de rotas de servico (raiz, saude e
catalogo de tipos de subvencao) e o router da v2, que carrega o produto de
fato -- descoberta de oportunidades, geracao assistida por agentes e
analytics. Ver routes/v2_routes.py.

Uso local:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from contextlib import asynccontextmanager
from datetime import UTC, datetime

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import GRANT_TYPES, get_settings
from routes import v2_router

# Configure structured logging (simplified for compatibility)
structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.dev.ConsoleRenderer(colors=True)
    ],
    wrapper_class=structlog.make_filtering_bound_logger(0),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=True
)

logger = structlog.get_logger()


# ===========================================================================
# Application Lifecycle
# ===========================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan with startup/shutdown events."""
    # Startup
    logger.info("application_startup", message="Agent Framework Backend starting...")
    settings = get_settings()
    logger.info(
        "configuration_loaded",
        azure_endpoint=settings.azure_openai_endpoint[:30] + "..." if settings.azure_openai_endpoint else "Not configured",
        grant_types=len(GRANT_TYPES)
    )
    
    yield
    
    # Shutdown
    logger.info("application_shutdown", message="Agent Framework Backend shutting down...")


# ===========================================================================
# FastAPI Application
# ===========================================================================

app = FastAPI(
    title="Smart Grant Request",
    description=(
        "Backend de descoberta e redacao de subvencoes para escolas K-12, "
        "construido sobre o Microsoft Agent Framework. As rotas do produto "
        "ficam sob /v2."
    ),
    version="2.0.0",
    lifespan=lifespan
)

# CORS for Next.js frontend - parse from config string
settings = get_settings()
cors_origins_list = [origin.strip() for origin in settings.cors_origins.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins_list + ["https://*.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(v2_router)


# ===========================================================================
# API Routes
# ===========================================================================

@app.get("/")
async def root():
    """Health check and API info."""
    return {
        "service": "Smart Grant Request",
        "version": "2.0.0",
        "status": "healthy",
        "timestamp": datetime.now(UTC).isoformat(),
        "endpoints": {
            "/health": "GET - Health check",
            "/grants/types": "GET - List available grant types",
            "/v2/workflow/discover": "POST - Rank live funding opportunities for a school",
            "/v2/workflow/generate": "POST - Draft an application for a chosen opportunity",
            "/v2/analytics/landscape": "GET - Aggregate view of the open funding landscape",
            "/v2/analytics/pulse": "GET - Recent activity signals",
            "/docs": "GET - OpenAPI reference"
        }
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    settings = get_settings()
    return {
        "status": "healthy",
        "timestamp": datetime.now(UTC).isoformat(),
        "azure_configured": bool(settings.azure_openai_api_key) or bool(settings.azure_openai_endpoint),
        "grants_api_configured": bool(settings.gsa_search_api_key)
    }


@app.get("/grants/types")
async def list_grant_types():
    """List all available grant types."""
    return {
        "types": [
            {
                "key": key,
                "name": info["name"],
                "amount": info["amount"],
                "deadline": info["deadline"],
            }
            for key, info in GRANT_TYPES.items()
        ]
    }


# ===========================================================================
# Run with uvicorn
# ===========================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
