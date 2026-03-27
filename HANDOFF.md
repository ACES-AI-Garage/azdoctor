# AzDoctor Boot Diagnostics — Session Handoff

## What was done
1. Cloned `ACES-AI-Garage/azdoctor` to `C:\Users\faban\source\azdoctor`
2. Created branch `feature/vm-boot-diagnostics`
3. Modified 3 files to add VM boot diagnostics to the `investigate` tool:
   - `server/package.json` — added `@azure/arm-compute` dependency
   - `server/src/utils/azure-client.ts` — added `createComputeClient()` and `getVmBootDiagnostics()` function
   - `server/src/tools/investigate.ts` — added section 8c: VM boot failure detection + serial console log retrieval
4. Built successfully (`npm run build` passes)
5. Updated MCP config at `C:\Users\faban\.copilot\mcp-config.json` to point to modified build

## What needs testing
- A test VM `vm-boot-test` exists in `rg-azdoctor-test2` (West US 2) with a corrupted BCD
- After restarting the CLI, run: `az login` → select subscription #37 (BAMI)
- Then ask AzDoctor to investigate `vm-boot-test` in `rg-azdoctor-test2` with symptom "cannot connect via RDP"
- The response should now include a `vmBootDiagnostics` section with:
  - `instanceInfo` (power state, VM agent status)
  - `possibleBootFailure: true`
  - `serialConsoleLog` (containing the Windows boot error)

## After testing — restore original MCP config
Edit `C:\Users\faban\.copilot\mcp-config.json` and change the path back to:
```
C:/Users/faban/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor/server/build/index.js
```

## After testing — clean up Azure resources
```
az group delete --name rg-azdoctor-test2 --yes --no-wait
```

## After testing — commit and push
```
cd C:\Users\faban\source\azdoctor
git add -A
git commit -m "feat: add VM boot diagnostics to investigate tool

When investigating a VM, AzDoctor now retrieves the instance view (power
state, VM agent status) and serial console log. Boot failure detection
triggers automatically when Available Memory is 0% with low CPU, or
Resource Health reports unhealthy.

This closes the diagnostic gap where Azure Resource Health reports a VM
as 'Available' at the platform level while the guest OS fails to boot
(e.g., corrupted BCD, missing winload.efi).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin feature/vm-boot-diagnostics
```
