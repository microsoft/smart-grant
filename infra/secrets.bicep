// =============================================================================
// Smart Grant Request — Semeadura de segredos
//
// Escreve pelo CONTROL PLANE (Microsoft.KeyVault/vaults/secrets). Essa é a
// razão pela qual o bootstrap funciona sem jumpbox, agente em VNet ou
// abertura temporária de firewall: o control plane do ARM não passa pelo
// firewall de data plane do cofre.
//
// Comprovado nesta subscription:
//   escrita via ARM ......... Succeeded
//   leitura via data plane .. Forbidden (public network access is disabled)
//
// Parâmetros @secure() não são gravados no histórico de implantação do ARM.
// =============================================================================

targetScope = 'resourceGroup'

@description('Nome do cofre criado por foundation.bicep.')
param vaultName string

@description('Chave de assinatura do cookie de sessão do frontend.')
@secure()
param authSecret string

@description('Senha de acesso à interface.')
@secure()
param authPassword string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource authSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'auth-secret'
  properties: {
    value: authSecret
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

resource authPasswordResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'auth-password'
  properties: {
    value: authPassword
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

// URIs sem versão: o Container Apps resolve sempre a versão mais recente e
// atualiza sozinho em até 30 minutos após uma rotação, reiniciando as
// revisões que referenciam o segredo. Fixar a versão quebraria isso.
//
// O linter alerta porque o NOME da saída contém "secret"/"password". O VALOR
// é apenas o endereço do segredo no cofre, não o segredo: quem o obtém ainda
// precisa de `Key Vault Secrets User` e de alcançar o data plane pelo private
// endpoint. Qualquer nome descritivo aqui cairia na mesma regra, então o
// alerta é silenciado com a justificativa em vez de mascarado por um nome pior.
#disable-next-line outputs-should-not-contain-secrets
output authSecretUri string = '${vault.properties.vaultUri}secrets/auth-secret'
#disable-next-line outputs-should-not-contain-secrets
output authPasswordUri string = '${vault.properties.vaultUri}secrets/auth-password'
