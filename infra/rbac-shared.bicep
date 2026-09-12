// =============================================================================
// Atribuicoes de papel nos recursos compartilhados: o registry e a conta de
// AI Foundry.
//
// Separado em módulo porque o ACR e a conta de AI Foundry vivem em outro
// resource group, e uma atribuição de papel precisa ser implantada no escopo
// do recurso que ela protege.
// =============================================================================

targetScope = 'resourceGroup'

@description('Nome do Azure Container Registry compartilhado.')
param acrName string

@description('Nome da conta de Azure AI Services (Foundry).')
param aiAccountName string

@description('Principal ID da identidade do frontend.')
param frontendPrincipalId string

@description('Principal ID da identidade do backend.')
param backendPrincipalId string

@description('Principal ID da identidade do pipeline. Em branco, nenhum push e autorizado.')
param deployPrincipalId string = ''

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource aiAccount 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: aiAccountName
}

// Pull de imagem por identidade gerenciada. Substitui a credencial de
// administrador do registry, que hoje é armazenada como segredo nas apps.
resource frontendAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, frontendPrincipalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: frontendPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource backendAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, backendPrincipalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: backendPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// O pipeline publica as imagens. AcrPush inclui pull e push, e nada mais --
// nao apaga repositorio, nao gerencia o registry. Substitui a credencial de
// admin do ACR, que era o ultimo par usuario/senha de vida longa guardado
// como segredo no repositorio do GitHub.
resource deployAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  scope: acr
  name: guid(acr.id, deployPrincipalId, acrPushRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// A conta de AI Foundry tem `disableLocalAuth = true`: chaves de API estão
// desativadas no recurso, então o acesso por Entra ID não é uma preferência,
// é o único caminho possível.
resource backendOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: aiAccount
  name: guid(aiAccount.id, backendPrincipalId, openAiUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: backendPrincipalId
    principalType: 'ServicePrincipal'
  }
}
