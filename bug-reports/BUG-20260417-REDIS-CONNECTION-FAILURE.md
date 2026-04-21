# BUG-20260417-001: Redis Connection Failure Causing Backend Startup Crash
## Basic Information
| Item | Details |
|------|---------|
| Bug ID | BUG-20260417-001 |
| Report Time | 2026-04-17 |
| Affected Component | Backend Service (main.py) |
| Severity | Critical (P1) |
| Status | Unresolved |
| Reproducibility | 100% |

## Error Description
The backend service fails to start completely with a Redis connection error:
```
redis.exceptions.ConnectionError: Error 22 connecting to localhost:6379. 远程计算机拒绝网络连接。
ERROR:    Application startup failed. Exiting.
```

## Root Cause Analysis
1. **Primary Cause**: Local Redis service is not running on the default port 6379, connection is actively refused
2. **Code Design Defects**:
   - Redis connection parameters are hardcoded to `localhost:6379` with no environment variable configuration support
   - No connection timeout setting in Redis initialization
   - No graceful degradation mechanism: service cannot start at all when Redis is unavailable, even for single-node testing scenarios
   - Connection health check (`ping()`) is mandatory on startup with no fallback logic

## Impact Scope
- Complete backend service outage, all endpoints are unavailable
- Blocks all AICartographer batch analysis functionality
- Prevents local development and testing without Redis installed

## Temporary Workaround
1. Install Redis for Windows (https://github.com/tporadowski/redis/releases)
2. Start the Redis service locally with default configuration (port 6379)
3. Restart the backend service

## Permanent Fix Recommendations
1. Add environment variable support for Redis configuration:
   - `REDIS_HOST`: Redis server address (default: localhost)
   - `REDIS_PORT`: Redis server port (default: 6379)
   - `REDIS_DB`: Redis database number (default: 0)
   - `REDIS_TIMEOUT`: Connection timeout in seconds (default: 5)
2. Add graceful degradation logic:
   - Add a fallback mode that uses in-memory storage when Redis is unavailable for local testing
   - Make Redis optional for single-node deployments
3. Improve error handling:
   - Add more descriptive error messages for Redis connection failures
   - Add retry mechanism for Redis connection on startup
4. Update deployment documentation:
   - Explicitly list Redis as a required dependency for batch processing mode
   - Provide single-node deployment instructions without Redis requirement

## Related Code Snippet (main.py Lines 136-138)
```python
redis_client = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)
# Verify connection
await redis_client.ping()
```
