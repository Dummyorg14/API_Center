$ErrorActionPreference = 'Stop'

Write-Host '1) Issue regular demand-service token' -ForegroundColor Cyan
$tokenResp = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/auth/token' -ContentType 'application/json' -Body '{"tribeId":"demand-service","secret":"demand-secret"}'
$regularToken = $tokenResp.data.accessToken

Write-Host '2) Call registry with regular token (should be denied)' -ForegroundColor Cyan
$regularStatus = 'UNKNOWN'
try {
  Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/api/v1/registry/services' -Headers @{ Authorization = "Bearer $regularToken" } | Out-Null
  $regularStatus = 'UNEXPECTED_SUCCESS'
} catch {
  $regularStatus = $_.Exception.Response.StatusCode.value__
}
Write-Host "regular token status: $regularStatus"

Write-Host '3) Generate dev-jwt admin token signed by gateway key' -ForegroundColor Cyan
$adminToken = docker exec api-center-1 node --input-type=module -e "import { SignJWT, importPKCS8 } from 'jose'; const key = await importPKCS8(process.env.JWT_PRIVATE_KEY, 'RS256'); const token = await new SignJWT({ tribeId: 'platform-admin', scopes: ['platform:admin'], permissions: ['platform:admin'] }).setProtectedHeader({ alg: 'RS256', kid: 'dev-key-1' }).setSubject('platform-admin').setIssuer('api-center-dev').setIssuedAt().setExpirationTime('1h').sign(key); console.log(token);"
if (-not $adminToken) { throw 'Failed to generate admin token' }

Write-Host '4) Call registry with generated admin JWT (should succeed)' -ForegroundColor Cyan
$adminResp = Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/api/v1/registry/services' -Headers @{ Authorization = "Bearer $adminToken" }

Write-Host 'admin token status: SUCCESS' -ForegroundColor Green
Write-Host "registry total: $($adminResp.meta.total)"
$ids = @($adminResp.data | Select-Object -ExpandProperty serviceId)
Write-Host "services: $($ids -join ', ')"

Write-Host '5) Validate service registration CRUD with admin JWT' -ForegroundColor Cyan
$tmpServiceId = 'tmp-admin-check'
$manifest = @{
  serviceId = $tmpServiceId
  name = 'Temp Admin Check'
  baseUrl = 'http://tmp-admin-check.local:4300'
  requiredScopes = @('tmp:read')
  exposes = @('/health')
  consumes = @()
  version = '1.0.0'
} | ConvertTo-Json -Depth 4

$headers = @{
  Authorization = "Bearer $adminToken"
  'Content-Type' = 'application/json'
}

$registered = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/registry/register' -Headers $headers -Body $manifest
Write-Host "register status: SUCCESS ($($registered.data.serviceId))" -ForegroundColor Green

try {
  $fetched = Invoke-RestMethod -Method Get -Uri "http://localhost:3000/api/v1/registry/services/$tmpServiceId" -Headers @{ Authorization = "Bearer $adminToken" }
  Write-Host "lookup via LB: SUCCESS ($($fetched.data.baseUrl))" -ForegroundColor Green
} catch {
  Write-Host "lookup via LB: NOT FOUND on this hop (likely another instance)" -ForegroundColor Yellow
}

foreach ($container in @('api-center-1', 'api-center-2', 'api-center-3')) {
  try {
    docker exec $container sh -lc "wget -qO- --header='Authorization: Bearer $adminToken' http://localhost:3000/api/v1/registry/services/$tmpServiceId" | Out-Null
    Write-Host "lookup on ${container}: FOUND" -ForegroundColor Green
  } catch {
    Write-Host "lookup on ${container}: NOT FOUND" -ForegroundColor Yellow
  }
}

try {
  $deleted = Invoke-RestMethod -Method Delete -Uri "http://localhost:3000/api/v1/registry/services/$tmpServiceId" -Headers @{ Authorization = "Bearer $adminToken" }
  Write-Host "cleanup via LB: SUCCESS ($($deleted.data.message))" -ForegroundColor Green
} catch {
  Write-Host "cleanup via LB: NOT FOUND on this hop" -ForegroundColor Yellow
}