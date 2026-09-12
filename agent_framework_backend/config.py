"""
============================================================================
Configuration Management
K-12 Grant Writing Multi-Agent System with Microsoft Agent Framework
============================================================================
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables.
    Compatible with your existing .env.local file.
    """
    
    # ========================================================================
    # Azure OpenAI Configuration (same as your Next.js app)
    # ========================================================================
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_deployment: str = "gpt-4o"
    azure_openai_api_version: str = "2025-04-01-preview"
    
    # ========================================================================
    # Agent Framework Configuration
    # ========================================================================
    agent_framework_log_level: str = "INFO"
    enable_checkpointing: bool = True
    enable_human_in_loop: bool = False  # Can be enabled for compliance review
    max_agent_retries: int = 3
    agent_timeout_seconds: int = 120
    
    # ========================================================================
    # Grant Sources Configuration
    # ========================================================================
    # GSA Search.gov API — optional fallback index only; the primary path is
    # the keyless Grants.gov search2 API. Supply via the GSA_SEARCH_API_KEY
    # environment variable. Never hardcode a credential here: this module is
    # baked into every container image.
    gsa_search_api_key: str = ""
    gsa_search_affiliate: str = "prod_grants"
    grants_gov_cache_ttl_minutes: int = 15
    
    # State Portals Configuration
    enabled_states: str = "CA,TX,NY,FL,IL"
    
    # ========================================================================
    # Pulse — portal usage analytics
    # ========================================================================
    # URL da conta de armazenamento que guarda o log de eventos, no formato
    # https://<conta>.blob.core.windows.net. A autenticacao e sempre por
    # Entra ID (DefaultAzureCredential); nao existe caminho por chave.
    # Em branco, o Pulse fica desligado e o painel mostra o estado vazio.
    pulse_storage_account_url: str = ""
    pulse_storage_container: str = "pulse"
    # Escotilha de desenvolvimento local: o emulador Azurite so fala chave
    # compartilhada. So e consultada quando pulse_storage_account_url esta em
    # branco -- assim uma variavel esquecida no ambiente nunca consegue
    # rebaixar a autenticacao de uma instalacao real.
    pulse_storage_connection_string: str = ""

    # ========================================================================
    # Server Configuration
    # ========================================================================
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    
    # ========================================================================
    # Observability Configuration
    # ========================================================================
    enable_telemetry: bool = True
    otlp_endpoint: str | None = None
    service_name: str = "grant-agent-framework"
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# ============================================================================
# Agent Configurations
# ============================================================================

AGENT_CONFIGS = {
    "discovery": {
        "name": "Discovery Agent",
        "role": "Grant Matching Specialist",
        "emoji": "🔍",
        "color": "#3B82F6",  # Blue
        "max_tokens": 700,
        "temperature": 0.3,  # Lower for accurate grant matching
    },
    "narrative": {
        "name": "Narrative Agent",
        "role": "Compelling Grant Writer",
        "emoji": "📝",
        "color": "#8B5CF6",  # Purple
        "max_tokens": 900,
        "temperature": 0.3,  # Lower to prevent data fabrication
    },
    "budget": {
        "name": "Budget Agent",
        "role": "Financial Planning Specialist",
        "emoji": "💰",
        "color": "#10B981",  # Green
        "max_tokens": 900,
        "temperature": 0.2,  # Very low for precise budget calculations
    },
    "compliance": {
        "name": "Compliance Agent",
        "role": "Quality Assurance Specialist",
        "emoji": "✅",
        "color": "#F59E0B",  # Orange
        "max_tokens": 600,
        "temperature": 0.2,  # Low for accurate compliance checking
    },
    "intelligence": {
        "name": "Intelligence Agent",
        "role": "AI Insights Specialist",
        "emoji": "🧠",
        "color": "#6366F1",  # Indigo
        "max_tokens": 800,
        "temperature": 0.3,  # Lower for accurate analysis
    },
    "writer": {
        "name": "Application Writer",
        "role": "Professional Grant Application Writer",
        "emoji": "📄",
        "color": "#EC4899",  # Pink
        "max_tokens": 3500,
        "temperature": 0.25,  # Low temperature to prevent hallucination
    },
}

# ============================================================================
# Grant Type Configurations (matching your frontend)
# ============================================================================

GRANT_TYPES = {
    # Federal STEM & Technology Grants
    "stem": {"name": "NSF STEM Innovation Grant", "amount": "$150,000", "deadline": "45 days"},
    "ed-tech": {"name": "ED Tech Innovation Grant", "amount": "$250,000", "deadline": "60 days"},
    "computer-science": {"name": "Computer Science for All", "amount": "$180,000", "deadline": "50 days"},
    "maker-space": {"name": "Innovative STEM Maker Space", "amount": "$200,000", "deadline": "55 days"},
    
    # Special Education & Accessibility
    "special-ed": {"name": "IDEA Part B Special Education Grant", "amount": "$200,000", "deadline": "60 days"},
    "accessibility": {"name": "ADA School Accessibility", "amount": "$175,000", "deadline": "75 days"},
    "behavioral-support": {"name": "Positive Behavioral Interventions", "amount": "$120,000", "deadline": "40 days"},
    
    # Career & Technical Education
    "cte": {"name": "Perkins V Career & Technical Education Grant", "amount": "$125,000", "deadline": "30 days"},
    "apprenticeship": {"name": "Youth Apprenticeship Program", "amount": "$160,000", "deadline": "65 days"},
    "dual-enrollment": {"name": "Dual Enrollment Expansion", "amount": "$95,000", "deadline": "35 days"},
    
    # Literacy & Academic Support
    "literacy": {"name": "Comprehensive Literacy Grant", "amount": "$300,000", "deadline": "90 days"},
    "title-i": {"name": "Title I School Improvement", "amount": "$220,000", "deadline": "70 days"},
    "ap-expansion": {"name": "AP/IB Program Expansion", "amount": "$85,000", "deadline": "42 days"},
    
    # Health & Wellness
    "nutrition": {"name": "Fresh Fruit & Vegetable Program", "amount": "$75,000", "deadline": "38 days"},
    "mental-health": {"name": "School Mental Health Services", "amount": "$140,000", "deadline": "55 days"},
    "physical-education": {"name": "Physical Education Modernization", "amount": "$110,000", "deadline": "45 days"},
    
    # Arts & Enrichment
    "arts": {"name": "Arts Education Enhancement", "amount": "$90,000", "deadline": "48 days"},
    "music": {"name": "Music Education Instruments", "amount": "$65,000", "deadline": "40 days"},
    
    # Safety & Infrastructure
    "school-safety": {"name": "School Safety & Security Grant", "amount": "$130,000", "deadline": "52 days"},
    "green-energy": {"name": "Green Schools Initiative", "amount": "$280,000", "deadline": "95 days"},
    "hvac": {"name": "IAQ & HVAC Improvement", "amount": "$240,000", "deadline": "80 days"},
    
    # English Learners & Equity
    "ell": {"name": "English Language Acquisition", "amount": "$135,000", "deadline": "58 days"},
    "equity": {"name": "Educational Equity Initiative", "amount": "$155,000", "deadline": "62 days"},
    "homeless-support": {"name": "McKinney-Vento Homeless Support", "amount": "$80,000", "deadline": "35 days"},
    
    # Custom
    "other": {"name": "Custom Grant Application", "amount": "Variable", "deadline": "45 days"},
}
