package api

import "testing"

func TestWhitelistedIdent_PanicsOnUnsafe(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic on unsafe identifier")
		}
	}()
	whitelistedIdent(`"; DROP TABLE x; --`)
}

func TestWhitelistedIdent_AllowsSafeNames(t *testing.T) {
	cases := []string{"callingcards", "hackett_meta", "_foo", "ABC123"}
	for _, c := range cases {
		if got := whitelistedIdent(c); got != c {
			t.Errorf("whitelistedIdent(%q) = %q, want %q", c, got, c)
		}
	}
}
