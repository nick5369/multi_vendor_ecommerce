package main

import (
	"crypto/rsa"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// jwksCache holds the auth-service public keys. Unknown key ids trigger one refresh, rate limited
// so a stream of forged tokens cannot turn into a stream of outbound fetches.
type jwksCache struct {
	url         string
	mu          sync.RWMutex
	keys        map[string]*rsa.PublicKey
	lastRefresh time.Time
}

func newJWKSCache(url string) *jwksCache { return &jwksCache{url: url, keys: map[string]*rsa.PublicKey{}} }

func (j *jwksCache) key(kid string) (*rsa.PublicKey, error) {
	j.mu.RLock()
	k, ok := j.keys[kid]
	j.mu.RUnlock()
	if ok {
		return k, nil
	}
	if err := j.refresh(); err != nil {
		return nil, err
	}
	j.mu.RLock()
	defer j.mu.RUnlock()
	if k, ok := j.keys[kid]; ok {
		return k, nil
	}
	return nil, errors.New("unknown key id")
}

func (j *jwksCache) refresh() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if time.Since(j.lastRefresh) < 10*time.Second && len(j.keys) > 0 {
		return nil
	}
	resp, err := http.Get(j.url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks status %d", resp.StatusCode)
	}
	var doc struct {
		Keys []struct{ Kid, Kty, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	fresh := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		fresh[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	j.keys, j.lastRefresh = fresh, time.Now()
	return nil
}

type claims struct {
	Roles   []string `json:"roles"`
	StoreID string   `json:"storeId"`
	jwt.RegisteredClaims
}

type Principal struct {
	UserID  string
	Roles   []string
	StoreID string
}

func (p Principal) has(role string) bool {
	for _, r := range p.Roles {
		if r == role {
			return true
		}
	}
	return false
}

type Authenticator struct {
	cfg  Config
	jwks *jwksCache
}

func newAuthenticator(cfg Config) *Authenticator {
	return &Authenticator{cfg: cfg, jwks: newJWKSCache(cfg.JWKSURL)}
}

func (a *Authenticator) parse(header string) (*Principal, error) {
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	var cl claims
	_, err := jwt.ParseWithClaims(header[7:], &cl, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return a.jwks.key(kid)
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(a.cfg.Issuer), jwt.WithAudience(a.cfg.Audience), jwt.WithExpirationRequired())
	if err != nil || cl.Subject == "" {
		return nil, errors.New("invalid token")
	}
	return &Principal{UserID: cl.Subject, Roles: cl.Roles, StoreID: cl.StoreID}, nil
}

// require authenticates the caller and checks they hold at least one of the roles.
func (a *Authenticator) require(roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, err := a.parse(c.GetHeader("Authorization"))
		if err != nil {
			writeError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or missing token", nil)
			return
		}
		allowed := len(roles) == 0
		for _, r := range roles {
			allowed = allowed || p.has(r)
		}
		if !allowed {
			writeError(c, http.StatusForbidden, "FORBIDDEN", "Insufficient role", nil)
			return
		}
		c.Set("principal", p)
		c.Set("userId", p.UserID)
		c.Next()
	}
}

func principal(c *gin.Context) *Principal { return c.MustGet("principal").(*Principal) }

// internalOnly guards service-to-service endpoints with the shared secret (constant-time comparison).
func internalOnly(token string) gin.HandlerFunc {
	expected := []byte(token)
	return func(c *gin.Context) {
		if subtle.ConstantTimeCompare(expected, []byte(c.GetHeader("X-Internal-Token"))) != 1 {
			writeError(c, http.StatusForbidden, "FORBIDDEN", "Internal endpoint", nil)
			return
		}
		c.Next()
	}
}
