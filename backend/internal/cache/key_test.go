package cache

import (
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestKey_StableAcrossQueryParamOrder(t *testing.T) {
	u1, _ := url.Parse("/api/v/2026-05-12/binding?regulator=YBR289W&datasets=harbison,callingcards")
	u2, _ := url.Parse("/api/v/2026-05-12/binding?datasets=harbison,callingcards&regulator=YBR289W")
	require.Equal(t,
		Key("2026-05-12", "GET", u1.Path, u1.Query()),
		Key("2026-05-12", "GET", u2.Path, u2.Query()),
	)
}

func TestKey_DifferentVersionsDiffer(t *testing.T) {
	u, _ := url.Parse("/api/v/2026-05-12/binding?regulator=YBR289W")
	require.NotEqual(t,
		Key("2026-05-12", "GET", u.Path, u.Query()),
		Key("2026-06-01", "GET", u.Path, u.Query()),
	)
}
