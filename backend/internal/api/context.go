package api

import (
	"context"
	"time"
)

func contextWithDB(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}
