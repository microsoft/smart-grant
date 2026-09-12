// =============================================================================
// Smart Grant Request — Ambiente Container Apps e aplicações
//
// O ambiente é integrado à VNet. Isso é o que permite que as aplicações
// resolvam e alcancem o Key Vault pelo private endpoint: a resolução de
// referências `keyVaultUrl` sai pela rede da aplicação, não por um plano de
// controle desacoplado.
//
// Um ambiente NÃO pode receber integração de VNet depois de criado — por isso
// esta é uma pilha nova em vez de uma alteração da existente.
// =============================================================================

targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('Subnet delegada, produzida por foundation.bicep.')
param acaSubnetId string

@description('Resource ID da identidade do frontend.')
param frontendIdentityId string

@description('Resource ID da identidade do backend.')
param backendIdentityId string

@description('Client ID da identidade do backend. Necessário para DefaultAzureCredential.')
param backendIdentityClientId string

@description('URI sem versão do segredo auth-secret.')
param authSecretUri string

@description('URI sem versão do segredo auth-password.')
// O valor é o endereço do segredo, não o segredo: quem o lê precisa de RBAC no cofre.
#disable-next-line secure-secrets-in-params
param authPasswordUri string

@description('Tag da imagem a implantar nas duas aplicações.')
param imageTag string

@description('''
Resource group que hospeda o ACR, o Log Analytics e a conta de AI Foundry.
Pode ser o mesmo resource group da aplicacao. Sao recursos compartilhados
porque costumam ser reaproveitados por varios projetos.
''')
param sharedResourceGroupName string

@description('''
Servidor de login do seu Azure Container Registry, no formato
`<nome>.azurecr.io`. Obtenha com:
  az acr show -n <nome> --query loginServer -o tsv
''')
param acrLoginServer string

@description('''
Nome do workspace do Log Analytics que recebe os logs das aplicacoes. Precisa
existir em `sharedResourceGroupName`.
''')
param logAnalyticsWorkspaceName string

@description('''
Endpoint da sua conta de Azure AI Foundry (ou Azure OpenAI), no formato
`https://<conta>.cognitiveservices.azure.com/`. Obtenha com:
  az cognitiveservices account show -n <conta> -g <rg> --query properties.endpoint -o tsv

Este e o unico servico externo que o produto exige. O acesso e por Entra ID --
nenhuma chave de API e necessaria nem armazenada.
''')
param openAiEndpoint string

@description('Nome da implantacao de modelo usada pelo caminho v1.')
param openAiDeployment string = 'gpt-4o'
param openAiApiVersion string = '2025-04-01-preview'

// O pipeline v2 fala com a Responses API, que o Azure so habilita a partir de
// 2025-03-01-preview; por isso esta versao e separada da usada pelo v1.
param foundryApiVersion string = '2025-03-01-preview'
param foundryDeploymentGpt54 string = 'gpt-5.4'
param authUsername string = 'admin'

@description('''
Endpoint de blob da conta que guarda o log do Pulse, no formato
https://<conta>.blob.core.windows.net/ — saída de foundation.bicep. Em branco,
o backend não registra uso e o painel declara que não está gravando.
''')
param pulseStorageBlobEndpoint string = ''

@description('Container dos blobs diários do Pulse.')
param pulseStorageContainer string = 'pulse'
@description('''
Principal ID da identidade do pipeline, produzida por foundation.bicep. Em
branco, nenhuma permissao de deploy e concedida -- util para implantar a pilha
numa assinatura onde o CI nao publica.
''')
param deployPrincipalId string = ''
var frontendAppName = 'ca-smartgrant-frontend'
var backendAppName = 'ca-smartgrant-backend'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: logAnalyticsWorkspaceName
  scope: resourceGroup(sharedResourceGroupName)
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-smartgrant'
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnetId
      // `internal: false` mantém o ingress do frontend acessível pela
      // internet. A integração de VNet existe para a saída em direção ao
      // private endpoint, não para esconder a interface.
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

// -----------------------------------------------------------------------------
// Backend — ingress interno, sem nenhum segredo
//
// A conta de AI Foundry tem chaves locais desativadas, então o acesso ao
// modelo é exclusivamente por Entra ID. AZURE_OPENAI_API_KEY foi removida de
// propósito: existia vazia e só confundia a lógica de seleção de credencial.
// -----------------------------------------------------------------------------

resource backend 'Microsoft.App/containerApps@2024-03-01' = {
  name: backendAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${backendIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      // Pull por identidade gerenciada: sem credencial de admin do registry.
      registries: [
        {
          server: acrLoginServer
          identity: backendIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: backendAppName
          image: '${acrLoginServer}/smartgrant-backend:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: openAiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: openAiDeployment
            }
            {
              name: 'AZURE_OPENAI_API_VERSION'
              value: openAiApiVersion
            }
            {
              name: 'FOUNDRY_ENDPOINT'
              value: openAiEndpoint
            }
            {
              name: 'FOUNDRY_API_VERSION'
              value: foundryApiVersion
            }
            {
              // A conta de IA tem autenticacao local desabilitada; sem isto o
              // cliente tentaria usar chave e seria recusado.
              name: 'FOUNDRY_USE_AAD'
              value: 'true'
            }
            {
              name: 'FOUNDRY_DEPLOYMENT_GPT_5_4'
              value: foundryDeploymentGpt54
            }
            {
              // Log de uso do portal. Em branco, o Pulse fica desligado e o
              // painel diz isso, em vez de inventar numero para preencher.
              name: 'PULSE_STORAGE_ACCOUNT_URL'
              value: pulseStorageBlobEndpoint
            }
            {
              name: 'PULSE_STORAGE_CONTAINER'
              value: pulseStorageContainer
            }
            {
              name: 'LOG_LEVEL'
              value: 'INFO'
            }
            {
              // Sem isto, DefaultAzureCredential não sabe QUAL identidade
              // atribuída pelo usuário deve usar e a autenticação falha.
              name: 'AZURE_CLIENT_ID'
              value: backendIdentityClientId
            }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8000
              }
              initialDelaySeconds: 30
              periodSeconds: 60
              timeoutSeconds: 10
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Frontend — segredos vindos do Key Vault por referência
//
// URIs sem versão: uma rotação no cofre é adotada automaticamente em até
// 30 minutos, sem nova implantação.
// -----------------------------------------------------------------------------

resource frontend 'Microsoft.App/containerApps@2024-03-01' = {
  name: frontendAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${frontendIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: frontendIdentityId
        }
      ]
      secrets: [
        {
          name: 'auth-secret'
          keyVaultUrl: authSecretUri
          identity: frontendIdentityId
        }
        {
          name: 'auth-password'
          keyVaultUrl: authPasswordUri
          identity: frontendIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: frontendAppName
          image: '${acrLoginServer}/smartgrant-frontend:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              // Resolução interna pelo nome da aplicação dentro do ambiente.
              name: 'AGENT_FRAMEWORK_URL'
              value: 'http://${backendAppName}'
            }
            {
              // Nome de usuário não é segredo: não pertence ao cofre.
              name: 'AUTH_USERNAME'
              value: authUsername
            }
            {
              name: 'AUTH_PASSWORD'
              secretRef: 'auth-password'
            }
            {
              name: 'AUTH_SECRET'
              secretRef: 'auth-secret'
            }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                // `/login` é liberado pelo middleware e responde 200 sem cookie.
                path: '/login'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/login'
                port: 3000
              }
              initialDelaySeconds: 30
              periodSeconds: 60
              timeoutSeconds: 10
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    backend
  ]
}

// -----------------------------------------------------------------------------
// Permissao do pipeline
//
// O escopo e cada aplicacao, uma de cada vez -- nao o resource group. A
// identidade que troca a imagem nao alcanca o Key Vault, o armazenamento do
// Pulse, a rede nem as outras identidades.
//
// `Container Apps Contributor` e o papel embutido mais estreito que ainda
// permite escrever: `Container Apps Operator` tem leitura e acoes, mas nao
// `write`, entao nao consegue trocar imagem. O papel inclui `delete` sobre as
// duas apps; um papel personalizado removeria isso, ao custo de um artefato a
// mais para manter na assinatura. A troca foi aceita conscientemente.
// -----------------------------------------------------------------------------

var containerAppsContributorRoleId = '358470bc-b998-42bd-ab17-a7e34c199c0f'

resource backendDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  scope: backend
  name: guid(backend.id, deployPrincipalId, containerAppsContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', containerAppsContributorRoleId)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource frontendDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  scope: frontend
  name: guid(frontend.id, deployPrincipalId, containerAppsContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', containerAppsContributorRoleId)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output environmentId string = environment.id
output environmentDefaultDomain string = environment.properties.defaultDomain
output frontendFqdn string = frontend.properties.configuration.ingress.fqdn
output backendFqdn string = backend.properties.configuration.ingress.fqdn
