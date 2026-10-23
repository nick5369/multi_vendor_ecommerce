package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
		a.Key = "ts"
	case slog.MessageKey:
		a.Key = "msg"
	}
	return a
}})).With("service", "order-service")

var safeRequestID = regexp.MustCompile(`^[\w-]{8,64}$`)

const requestIDKey = "requestId"

// requestContext assigns/propagates X-Request-Id, adds security headers and writes one access-log line per request.
func requestContext() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-Id")
		if !safeRequestID.MatchString(id) {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header("X-Request-Id", id)
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Cache-Control", "no-store")
		start := time.Now()
		c.Next()
		if p := c.FullPath(); p == "/health" || p == "/metrics" {
			return
		}
		logger.Info("request", "requestId", id, "method", c.Request.Method, "path", c.Request.URL.Path,
			"status", c.Writer.Status(), "durationMs", float64(time.Since(start).Microseconds())/1000, "userId", c.GetString("userId"))
	}
}

// APIError is a business failure that maps to the standard error envelope.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details any
}

func (e *APIError) Error() string { return e.Message }

func newErr(status int, code, msg string) *APIError { return &APIError{Status: status, Code: code, Message: msg} }

func writeError(c *gin.Context, status int, code, msg string, details any) {
	body := gin.H{"code": code, "message": msg, "requestId": c.GetString(requestIDKey)}
	if details != nil {
		body["details"] = details
	}
	c.AbortWithStatusJSON(status, gin.H{"error": body})
}

// fail renders any error; unknown errors are logged and returned as a generic 500 (no internals leak).
func fail(c *gin.Context, err error) {
	if ae, ok := err.(*APIError); ok {
		writeError(c, ae.Status, ae.Code, ae.Message, ae.Details)
		return
	}
	logger.Error("unhandled error", "requestId", c.GetString(requestIDKey), "type", errType(err))
	writeError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Unexpected error", nil)
}

func errType(err error) string { return fmt.Sprintf("%T", err) }
