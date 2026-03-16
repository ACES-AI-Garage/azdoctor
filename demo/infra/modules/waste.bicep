param location string
param uniqueSuffix string

// --- Unattached Managed Disk ---
resource orphanedDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: 'disk-orphaned-prod'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    diskSizeGB: 32
    creationData: {
      createOption: 'Empty'
    }
  }
}

// --- Orphaned Public IP ---
resource orphanedIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: 'ip-orphaned-prod'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

// --- Stopped VM (setup.sh will stop it without deallocating) ---

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-waste-prod'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/24']
    }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.0.0.0/24'
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: 'nic-waste-prod'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: vnet.properties.subnets[0].id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-waste-prod-${uniqueSuffix}'
  location: location
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
    osProfile: {
      computerName: 'vmwaste'
      adminUsername: 'azureuser'
      adminPassword: 'AzD0ctor-Demo-2024!'
      linuxConfiguration: {
        disablePasswordAuthentication: false
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Standard_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

output vmName string = vm.name
