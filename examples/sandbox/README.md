# Functional Sandbox Runbook

This runbook validates the local Front Door pattern using dev-jwt only.

## 1) Build and start all containers

```powershell
docker compose down --remove-orphans
docker compose up -d --build
```

## 2) Register the mock services in the gateway registry

```powershell
curl -s -X POST http://localhost:3000/api/v1/registry/register `
  -H "Content-Type: application/json" `
  -H "X-Platform-Secret: change-me-in-production" `
  --data-binary "@examples/logistics-manifest.json"

curl -s -X POST http://localhost:3000/api/v1/registry/register `
  -H "Content-Type: application/json" `
  -H "X-Platform-Secret: change-me-in-production" `
  --data-binary "@examples/demand-manifest.json"
```

## 3) Front Door validation (Demand -> Gateway -> Logistics)

```powershell
curl -s http://localhost:4100/demand/ORD-1001 | jq .
```

Expected:
- 200 response
- JSON contains shipment data from logistics
- `correlationId` appears in demand response and logistics logs

## 4) NGINX round-robin check (12 requests)

Note:
- Round-robin is done by NGINX across `api-center-1/2/3` (gateway containers), not by `logistics-service`.
- Ensure `.env` has `RATE_LIMIT_MAX` high enough for this burst (for example `RATE_LIMIT_MAX=100`).
- If you changed `.env`, restart gateways: `docker-compose up -d --force-recreate api-center-1 api-center-2 api-center-3 nginx`.

```powershell
docker exec nginx-lb sh -lc ': > /var/log/nginx/access.log'
1..12 | ForEach-Object { Invoke-RestMethod -Uri "http://localhost:4100/demand/ORD-RR-$_" -Method Get | Out-Null }

$lines = docker exec nginx-lb sh -lc "cat /var/log/nginx/access.log"
$rows = @()
foreach ($line in $lines) {
  if ($line -match "ORD-RR-") {
    try { $rows += ($line | ConvertFrom-Json) } catch {}
  }
}

$rows | Group-Object upstream | Sort-Object Name | ForEach-Object {
  "{0} -> {1} requests" -f $_.Name, $_.Count
}
```

Expected: requests are split across multiple upstreams like `api-center-1:3000`, `api-center-2:3000`, `api-center-3:3000`.

## 5) Correlation ID propagation check

```powershell
$cid = [guid]::NewGuid().ToString()
curl -s http://localhost:4100/demand/ORD-CORR -H "X-Correlation-ID: $cid" | jq .

docker logs logistics-service 2>&1 | Select-String $cid
```

Expected: the same correlation ID is printed in logistics-service logs.

## 6) Rate limiting check (5 req/min, 6th => 429)

```powershell
1..6 | ForEach-Object {
  $r = curl -s -o NUL -w "%{http_code}" http://localhost:4100/demand/RATE-$_
  Write-Output "Request $_ -> $r"
}
```

Expected: first 5 requests mostly 200, request 6 returns 429.

## 7) Circuit breaker check (CLOSED -> OPEN)

1. Stop logistics to force upstream failures:

```powershell
docker stop logistics-service
```

2. Trigger failures via demand path:

```powershell
1..7 | ForEach-Object { curl -s -o NUL -w "%{http_code}`n" http://localhost:4100/demand/CB-$_ }
```

3. Check gateway breaker logs:

```powershell
docker logs api-center-1 2>&1 | Select-String "proxy:logistics-service"
docker logs api-center-2 2>&1 | Select-String "proxy:logistics-service"
docker logs api-center-3 2>&1 | Select-String "proxy:logistics-service"
```

Expected: log lines indicating breaker opened after repeated failures.

## 8) Kafka audit topic check (success + failure)

```powershell
docker exec -i kafka kafka-console-consumer --bootstrap-server kafka:29092 --topic api-center.audit.log --from-beginning --timeout-ms 15000
```

Expected: audit messages for successful and failed requests, including status codes and paths.
