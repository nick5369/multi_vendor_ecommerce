package main

import (
	"context"
	"embed"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

func runMigrations(dsn string) error {
	src, err := iofs.New(migrationFiles, "migrations")
	if err != nil {
		return err
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, "mysql://"+dsn+"&multiStatements=true")
	if err != nil {
		return err
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	return nil
}

func openDB(dsn string) (*gorm.DB, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
		if err == nil {
			sqlDB, derr := db.DB()
			if derr != nil {
				return nil, derr
			}
			// sized for bursts of concurrent cart operations; each request holds one connection per transaction
			sqlDB.SetMaxOpenConns(60)
			sqlDB.SetMaxIdleConns(20)
			return db, nil
		}
		lastErr = err
		time.Sleep(2 * time.Second)
	}
	return nil, lastErr
}

func newRouter(cfg Config, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), requestContext())
	r.GET("/health", func(c *gin.Context) {
		sqlDB, err := db.DB()
		if err == nil {
			err = sqlDB.PingContext(c.Request.Context())
		}
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "DOWN", "service": "order-service", "db": "down"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "UP", "service": "order-service", "db": "up"})
	})
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	auth := newAuthenticator(cfg)
	carts := NewCartService(db, newCatalogClient(cfg), cfg.CartMaxQuantity)
	registerCartRoutes(r, auth, carts)
	saga := NewSaga(db, newCatalogClient(cfg), newInventoryClient(cfg), newPaymentClient(cfg), cfg)
	registerOrderRoutes(r, auth, saga, db, cfg)
	startBackground(cfg, db, saga)

	r.NoRoute(func(c *gin.Context) { writeError(c, http.StatusNotFound, "NOT_FOUND", "Not found", nil) })
	return r
}

func main() {
	cfg := loadConfig()
	if err := runMigrations(cfg.MySQLDSN); err != nil {
		log.Fatalf("migrations failed: %v", err)
	}
	db, err := openDB(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("db connect failed: %v", err)
	}
	srv := &http.Server{Addr: ":" + cfg.Port, Handler: newRouter(cfg, db)}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// startBackground runs the outbox relay, the payment-event consumer and the reconciler for the life of the process.
func startBackground(cfg Config, db *gorm.DB, saga *Saga) {
	ctx := context.Background()
	broker := newBroker(cfg.RabbitURL, db)
	go broker.RunRelay(ctx)
	go broker.RunConsumer(ctx, saga.Handle)
	go saga.RunReconciler(make(chan struct{}))
}
