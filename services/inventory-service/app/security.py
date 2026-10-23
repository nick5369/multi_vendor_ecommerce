import hmac
from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import Header

from . import config
from .errors import ApiError

_jwks = jwt.PyJWKClient(config.JWKS_URL, cache_keys=True, lifespan=3600)


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    roles: frozenset[str]
    store_id: UUID | None


def _decode(authorization: str | None) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(401, "UNAUTHORIZED", "Missing bearer token")
    token = authorization[7:]
    try:
        key = _jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"], audience=config.JWT_AUDIENCE, issuer=config.JWT_ISSUER,
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
        store = claims.get("storeId")
        return Principal(UUID(claims["sub"]), frozenset(claims.get("roles", [])), UUID(store) if store else None)
    except (jwt.PyJWTError, ValueError):
        raise ApiError(401, "UNAUTHORIZED", "Invalid or expired token") from None


def require_seller(authorization: str | None = Header(default=None)) -> Principal:
    principal = _decode(authorization)
    if "SELLER" not in principal.roles:
        raise ApiError(403, "FORBIDDEN", "Seller role required")
    if principal.store_id is None:
        raise ApiError(403, "FORBIDDEN", "No active store for this account")
    return principal


def require_admin(authorization: str | None = Header(default=None)) -> Principal:
    principal = _decode(authorization)
    if "ADMIN" not in principal.roles:
        raise ApiError(403, "FORBIDDEN", "Admin role required")
    return principal


def require_internal(x_internal_token: str | None = Header(default=None)) -> None:
    """Service-to-service guard, compared in constant time."""
    expected = config.INTERNAL_SERVICE_TOKEN.encode()
    if x_internal_token is None or not hmac.compare_digest(expected, x_internal_token.encode()):
        raise ApiError(403, "FORBIDDEN", "Internal endpoint")
