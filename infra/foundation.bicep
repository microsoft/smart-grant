// =============================================================================
// Smart Grant Request — Fundação de rede e segredos
//
// Cria a topologia que torna o Key Vault utilizável neste tenant:
// o acesso público ao cofre é forçado a "Disabled" pela política
// MCAPSGov (efeito Modify, aplicado na admissão do ARM), portanto o
// único caminho de data plane possível é um private endpoint alcançado
// a partir de uma VNet.
//
// Os segredos são semeados pelo CONTROL PLANE (Microsoft.KeyVault/vaults/secrets),
// que não passa pelo firewall de data plane. As aplicações os consomem pelo
// private endpoint usando identidades gerenciadas.
// =============================================================================

targetScope = 'resourceGroup'

@description('Região de todos os recursos regionais.')
param location string = resourceGroup().location

@description('''
Nome do cofre. Nomes de Key Vault são únicos em TODO o Azure, não apenas na
subscription, e `az keyvault check-name` não enxerga cofres soft-deleted de
outros tenants. O padrão usa um sufixo determinístico derivado do resource
group E da região: estável entre implantações, imune a colisão, e distinto
por região — o que importa porque um cofre removido mantém o nome reservado
durante todo o período de soft-delete.
''')
@minLength(3)
@maxLength(24)
param vaultName string = 'kv-sgr-${uniqueString(resourceGroup().id, location)}'

@description('Prefixo de nomenclatura dos recursos.')
param namePrefix string = 'smartgrant'

@description('''
Nome da conta que guarda o log de eventos do Pulse. Nomes de conta de
armazenamento sao globais e aceitam apenas minusculas e digitos, dai o sufixo
deterministico em vez de um nome legivel.
''')
@minLength(3)
@maxLength(24)
param pulseStorageAccountName string = 'stsgr${uniqueString(resourceGroup().id, location)}'

@description('Container que recebe os blobs diarios do Pulse.')
param pulseContainerName string = 'pulse'

@description('''
Repositorio que publica em producao, no formato `dono/nome`. E o que prende a
credencial federada: so um push neste repositorio, neste branch, consegue
trocar a imagem em producao.
''')
param githubRepository string

@description('Unico branch autorizado a publicar em producao.')
param githubDeployBranch string = 'main'

@description('''
Prefixo do claim `sub` que o GitHub emite. Deixe vazio para o formato
convencional `repo:dono/nome`.

Organizacoes com "immutable OIDC subject" ligado emitem identificadores
numericos no lugar dos nomes -- por exemplo
`repo:microsoft@6154722/smart-grant@1367656231` -- e uma credencial registrada
com o formato convencional nunca casa: o login federado falha sem dizer por que.
Consulte o valor real do seu repositorio com:

  gh api repos/<dono>/<nome>/actions/oidc/customization/sub
''')
param githubSubjectPrefix string = ''
@description('''
Cria um private endpoint de blob para a conta do Pulse.

Deixe FALSE numa assinatura comum: o acesso já é exclusivamente por Entra ID e
o endpoint público basta, mantendo o custo em centavos por mês.

Ligue quando o tenant tiver uma política que force `publicNetworkAccess` para
Disabled em contas de armazenamento (MCAPSGov faz isso). Sem private endpoint,
nesse caso, a conta não é alcançável por ninguém — nem pelo backend. O endpoint
custa cerca de US$ 7,30/mês, mais que o próprio armazenamento neste volume, e
por isso é uma escolha explícita e não o padrão.
''')
param enablePulsePrivateEndpoint bool = false
@description('Espaço de endereçamento da VNet.')
param vnetAddressPrefix string = '10.60.0.0/16'

@description('Subnet de infraestrutura do Container Apps. Exige /23 no mínimo.')
param acaSubnetPrefix string = '10.60.0.0/23'

@description('Subnet dedicada a private endpoints.')
param privateEndpointSubnetPrefix string = '10.60.2.0/24'

@description('''
Proteção contra expurgo. É IRREVERSÍVEL: uma vez habilitada, não pode ser
desabilitada, e o cofre não pode ser removido antes do fim da retenção.
Recomendada para produção real; mantida desligada até decisão explícita.
''')
param enablePurgeProtection bool = false

var privateDnsZoneName = 'privatelink.vaultcore.azure.net'
var acaSubnetName = 'snet-aca'
var privateEndpointSubnetName = 'snet-pe'

// -----------------------------------------------------------------------------
// Rede
// -----------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2023-05-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        // Subnet de infraestrutura do ambiente Container Apps.
        // A delegação é obrigatória e imutável após a criação do ambiente.
        name: acaSubnetName
        properties: {
          addressPrefix: acaSubnetPrefix
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        // Private endpoints exigem que as network policies estejam desabilitadas.
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Sem esta zona o FQDN do cofre continua resolvendo para o IP público,
// que está bloqueado. A zona é o que redireciona a resolução para o
// endereço privado.
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: 'link-${vnet.name}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

// -----------------------------------------------------------------------------
// Key Vault
// -----------------------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId

    // RBAC em vez de access policies: modelo de autorização recomendado.
    enableRbacAuthorization: true

    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: enablePurgeProtection ? true : null

    // Declarado explicitamente para deixar a intenção registrada no código.
    // A política do tenant forçaria este valor de qualquer forma.
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${privateEndpointSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'vault-connection'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

// Cria automaticamente o registro A do cofre dentro da zona privada.
resource vaultPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-05-01' = {
  parent: vaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault-config'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
  dependsOn: [
    privateDnsZoneLink
  ]
}

// -----------------------------------------------------------------------------
// Identidades gerenciadas
//
// Atribuídas pelo usuário (não pelo sistema) por dois motivos concretos:
//  1. Referências de Key Vault precisam da identidade JÁ EXISTENTE no momento
//     da criação da app — uma identidade de sistema só nasce depois.
//  2. O mesmo vale para o pull da imagem no ACR sem credencial de admin.
// Uma identidade por aplicação, para manter privilégio mínimo real.
// -----------------------------------------------------------------------------

resource frontendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-frontend'
  location: location
}

resource backendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-backend'
  location: location
}

// A identidade do pipeline. Diferente das outras duas, ela nao roda dentro de
// nenhuma aplicacao: quem a usa e o GitHub Actions, de fora do Azure.
//
// A ponte e uma credencial federada em vez de uma senha. O GitHub emite um
// token OIDC por execucao, o Entra ID o troca por um token de acesso, e nada
// duradouro precisa ficar guardado no repositorio. O segredo anterior
// (`AZURE_CREDENTIALS`, um JSON com client secret) nunca foi rotacionado e
// apontava para um service principal de outra assinatura -- o deploy falhava
// com "container app nao existe" porque a identidade nao enxergava o recurso.
resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-deploy'
  location: location
}

// O `subject` prende o token a um branch especifico deste repositorio. Um
// token emitido para qualquer outro branch, tag, pull request ou repositorio
// nao casa com esta credencial e a troca falha.
var githubSubjectBase = empty(githubSubjectPrefix) ? 'repo:${githubRepository}' : githubSubjectPrefix

resource deployGithubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-${githubDeployBranch}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubSubjectBase}:ref:refs/heads/${githubDeployBranch}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// -----------------------------------------------------------------------------
// Armazenamento do Pulse
//
// Log append-only de uso do portal, um blob JSON Lines por dia. O acesso e
// exclusivamente por Entra ID (`allowSharedKeyAccess: false`), entao nao existe
// chave para vazar.
//
// `publicNetworkAccess` e declarado como Enabled de proposito: numa assinatura
// comum isso basta, e mantem o custo em centavos. Tenants governados (MCAPSGov,
// por exemplo) tem uma politica de efeito Modify que forca este campo para
// Disabled na admissao -- verificado neste tenant: uma tentativa de reabrir e
// revertida. La a conta so e alcancavel por private endpoint, e e para isso que
// serve o parametro abaixo.
// -----------------------------------------------------------------------------

resource pulseStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: pulseStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource pulseBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: pulseStorage
  name: 'default'
  properties: {
    // O log e a unica copia do historico de uso. Uma semana de retencao cobre
    // um apagamento acidental sem custo relevante nesse volume.
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource pulseContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: pulseBlobService
  name: pulseContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Private endpoint do blob. Custa cerca de US$ 7,30/mes -- mais que o proprio
// armazenamento neste volume -- por isso e opcional e vem desligado.
resource pulseDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (enablePulsePrivateEndpoint) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
}

resource pulseDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (enablePulsePrivateEndpoint) {
  parent: pulseDnsZone
  name: 'link-${vnet.name}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource pulsePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = if (enablePulsePrivateEndpoint) {
  name: 'pe-${pulseStorageAccountName}'
  location: location
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${privateEndpointSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'pulse-blob-connection'
        properties: {
          privateLinkServiceId: pulseStorage.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource pulsePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-05-01' = if (enablePulsePrivateEndpoint) {
  parent: pulsePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'pulse-blob-config'
        properties: {
          privateDnsZoneId: pulseDnsZone.id
        }
      }
    ]
  }
  dependsOn: [
    pulseDnsZoneLink
  ]
}

// -----------------------------------------------------------------------------
// Saídas
// -----------------------------------------------------------------------------

output vnetId string = vnet.id
output acaSubnetId string = '${vnet.id}/subnets/${acaSubnetName}'
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output vaultId string = vault.id

output pulseStorageAccountName string = pulseStorage.name
output pulseStorageBlobEndpoint string = pulseStorage.properties.primaryEndpoints.blob
output pulseStorageContainerName string = pulseContainer.name

output frontendIdentityId string = frontendIdentity.id
output frontendIdentityClientId string = frontendIdentity.properties.clientId
output frontendIdentityPrincipalId string = frontendIdentity.properties.principalId

output backendIdentityId string = backendIdentity.id
output backendIdentityClientId string = backendIdentity.properties.clientId
output backendIdentityPrincipalId string = backendIdentity.properties.principalId

output deployIdentityClientId string = deployIdentity.properties.clientId
output deployIdentityPrincipalId string = deployIdentity.properties.principalId
