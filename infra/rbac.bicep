// =============================================================================
// Smart Grant Request — Atribuições de papel
//
// Privilégio mínimo: cada identidade recebe apenas o que a sua aplicação
// precisa. O frontend nunca ganha acesso ao modelo; o backend nunca precisa
// dos segredos de autenticação da interface.
// =============================================================================

targetScope = 'resourceGroup'

@description('Nome do cofre criado por foundation.bicep.')
param vaultName string

@description('Principal ID da identidade do frontend.')
param frontendPrincipalId string

@description('Principal ID da identidade do backend.')
param backendPrincipalId string

@description('Principal ID da identidade do pipeline. Em branco, nenhum push no ACR e autorizado.')
param deployPrincipalId string = ''

@description('Conta de armazenamento que guarda o log de eventos do Pulse.')
param pulseStorageAccountName string

@description('Resource group que hospeda o ACR e a conta de AI Foundry.')
param sharedResourceGroupName string

@description('Nome do Azure Container Registry compartilhado.')
param acrName string

@description('Nome da conta de Azure AI Services (Foundry).')
param aiAccountName string

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

// Leitura de segredos apenas. Nenhuma das identidades pode criar, alterar
// ou apagar segredos — isso é feito por IaC pelo control plane.
resource frontendSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, frontendPrincipalId, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: frontendPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource backendSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, backendPrincipalId, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: backendPrincipalId
    principalType: 'ServicePrincipal'
  }
}

module sharedRbac 'rbac-shared.bicep' = {
  name: 'sgr-rbac-shared'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    acrName: acrName
    aiAccountName: aiAccountName
    frontendPrincipalId: frontendPrincipalId
    backendPrincipalId: backendPrincipalId
    deployPrincipalId: deployPrincipalId
  }
}

// -----------------------------------------------------------------------------
// Pulse
//
// Só o backend escreve no log de uso. O frontend fala com o Pulse pelo proxy,
// nunca com o armazenamento, então não recebe papel nenhum aqui. O escopo é a
// conta inteira porque é ela que existe só para isso.
// -----------------------------------------------------------------------------

resource pulseStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: pulseStorageAccountName
}

resource backendPulseWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: pulseStorage
  name: guid(pulseStorage.id, backendPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: backendPrincipalId
    principalType: 'ServicePrincipal'
  }
}
