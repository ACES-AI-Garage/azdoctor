param planName string
param appName string
param location string
param appInsightsConnectionString string
param sqlConnectionString string
param generateErrors bool

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: 'NODE|18-lts'
      alwaysOn: true
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'SQL_CONNECTION_STRING', value: sqlConnectionString }
        { name: 'GENERATE_ERRORS', value: string(generateErrors) }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~18' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
    httpsOnly: true
  }
}

output appUrl string = 'https://${app.properties.defaultHostName}'
output appName string = app.name
output planName string = plan.name
