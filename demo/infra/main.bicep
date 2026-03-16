targetScope = 'subscription'

@description('Azure region for all resources')
param location string = 'eastus2'

@description('SQL Server admin login')
param sqlAdminLogin string = 'sqladmin'

@secure()
@description('SQL Server admin password')
param sqlAdminPassword string

@description('Unique suffix to avoid name collisions')
param uniqueSuffix string = substring(uniqueString(subscription().subscriptionId), 0, 8)

// --- Resource Groups ---

resource rgProd 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'azdoctor-demo-prod'
  location: location
}

resource rgPreprod 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'azdoctor-demo-preprod'
  location: location
}

// --- Prod Environment (intentionally broken) ---

module prodLogAnalytics 'modules/loganalytics.bicep' = {
  name: 'prod-loganalytics'
  scope: rgProd
  params: {
    name: 'log-azdemo-prod-${uniqueSuffix}'
    location: location
  }
}

module prodAppInsights 'modules/appinsights.bicep' = {
  name: 'prod-appinsights'
  scope: rgProd
  params: {
    name: 'appi-azdemo-prod-${uniqueSuffix}'
    location: location
    workspaceId: prodLogAnalytics.outputs.workspaceId
  }
}

module prodAppService 'modules/appservice.bicep' = {
  name: 'prod-appservice'
  scope: rgProd
  params: {
    planName: 'plan-azdemo-prod-${uniqueSuffix}'
    appName: 'app-azdemo-prod-${uniqueSuffix}'
    location: location
    appInsightsConnectionString: prodAppInsights.outputs.connectionString
    sqlConnectionString: 'Server=tcp:sql-azdemo-prod-${uniqueSuffix}.database.windows.net,1433;Database=sqldb-azdemo-prod;User ID=${sqlAdminLogin};Password=${sqlAdminPassword};Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;'
    generateErrors: true
  }
}

module prodSql 'modules/sql.bicep' = {
  name: 'prod-sql'
  scope: rgProd
  params: {
    serverName: 'sql-azdemo-prod-${uniqueSuffix}'
    databaseName: 'sqldb-azdemo-prod'
    location: location
    adminLogin: sqlAdminLogin
    adminPassword: sqlAdminPassword
  }
}

module prodWaste 'modules/waste.bicep' = {
  name: 'prod-waste'
  scope: rgProd
  params: {
    location: location
    uniqueSuffix: uniqueSuffix
  }
}

// Empty App Service Plan (no apps deployed to it)
module prodEmptyPlan 'modules/emptyplan.bicep' = {
  name: 'prod-empty-plan'
  scope: rgProd
  params: {
    planName: 'plan-empty-prod-${uniqueSuffix}'
    location: location
  }
}

// --- Preprod Environment (healthy baseline) ---

module preprodLogAnalytics 'modules/loganalytics.bicep' = {
  name: 'preprod-loganalytics'
  scope: rgPreprod
  params: {
    name: 'log-azdemo-preprod-${uniqueSuffix}'
    location: location
  }
}

module preprodAppInsights 'modules/appinsights.bicep' = {
  name: 'preprod-appinsights'
  scope: rgPreprod
  params: {
    name: 'appi-azdemo-preprod-${uniqueSuffix}'
    location: location
    workspaceId: preprodLogAnalytics.outputs.workspaceId
  }
}

module preprodAppService 'modules/appservice.bicep' = {
  name: 'preprod-appservice'
  scope: rgPreprod
  params: {
    planName: 'plan-azdemo-preprod-${uniqueSuffix}'
    appName: 'app-azdemo-preprod-${uniqueSuffix}'
    location: location
    appInsightsConnectionString: preprodAppInsights.outputs.connectionString
    sqlConnectionString: 'Server=tcp:sql-azdemo-preprod-${uniqueSuffix}.database.windows.net,1433;Database=sqldb-azdemo-preprod;User ID=${sqlAdminLogin};Password=${sqlAdminPassword};Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;'
    generateErrors: false
  }
}

module preprodSql 'modules/sql.bicep' = {
  name: 'preprod-sql'
  scope: rgPreprod
  params: {
    serverName: 'sql-azdemo-preprod-${uniqueSuffix}'
    databaseName: 'sqldb-azdemo-preprod'
    location: location
    adminLogin: sqlAdminLogin
    adminPassword: sqlAdminPassword
  }
}

// --- Outputs ---

output prodResourceGroup string = rgProd.name
output preprodResourceGroup string = rgPreprod.name
output prodAppUrl string = prodAppService.outputs.appUrl
output preprodAppUrl string = preprodAppService.outputs.appUrl
output prodAppName string = prodAppService.outputs.appName
output preprodAppName string = preprodAppService.outputs.appName
output uniqueSuffix string = uniqueSuffix
