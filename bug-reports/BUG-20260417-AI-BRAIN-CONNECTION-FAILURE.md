# BUG-20260417-002: AI Brain Connection Failure (CONNECTION_SEVERED)
## Basic Information
| Item | Details |
|------|---------|
| Bug ID | BUG-20260417-002 |
| Report Time | 2026-04-17 |
| Affected Component | Frontend ↔ Backend Integration |
| Severity | Critical (P1) |
| Status | Unresolved |
| Reproducibility | 100% for existing frontend versions |

## Error Description
Frontend displays error: `CONNECTION_SEVERED: Unable to reach AI Brain` when attempting to analyze blueprints, even though backend service is running.

## Root Cause Analysis
### Primary Cause
Breaking change in API contract:
- Original synchronous single-node analysis endpoint `/api/analyze-blueprint` has been fully commented out and disabled during the Redis batch migration
- Existing frontend versions still call this legacy endpoint, resulting in 404 Not Found errors
- 404 responses are interpreted by the frontend as a connection failure

### Secondary Possible Causes (Low Probability)
1. Backend service not running on expected port 8000
2. Frontend configured with incorrect backend service address
3. Network/firewall blocking port 8000 traffic
4. CORS misconfiguration (ruled out: current CORS policy allows all origins)

### Code Defect
No backward compatibility maintained during API migration. Legacy endpoint was removed entirely without deprecation period or fallback implementation.

## Impact Scope
- Complete loss of functionality for all existing frontend deployments
- Single-node synchronous analysis feature is unavailable
- Blocks all user-facing analysis functionality

## Temporary Workaround
Uncomment the legacy `/api/analyze-blueprint` endpoint implementation in `main.py` lines 162-202 to restore backward compatibility.

## Permanent Fix Recommendations
1. Restore the legacy `/api/analyze-blueprint` endpoint implementation permanently, maintain single-node synchronous mode as a supported feature
2. Update frontend to use new batch endpoints incrementally, with feature flagging
3. Add API versioning strategy to avoid future breaking changes
4. Implement health check endpoint `/api/health` for frontend to verify backend availability without invoking analysis functions

## Related Code Snippet (main.py Lines 159-205)
```python
# ------------------------------
# LEGACY SYNCHRONOUS ENDPOINTS (COMMENTED OUT FOR MIGRATION)
# ------------------------------
# class ASTPayload(BaseModel):
#     name: str
#     ast: list | dict
# 
# @app.post("/api/analyze-blueprint")
# async def analyze_blueprint(payload: ASTPayload):
#     [ ... legacy implementation ... ]
# ------------------------------
# END OF LEGACY CODE
# ------------------------------
```
