package subscription

import (
	"fmt"
	"os"
	"strings"
)

// Approved prices are server-owned. A browser request can select only the
// public tier and billing interval; it cannot select a Razorpay plan or price.
const (
	proMonthlyPaise     int64 = 19900
	creatorMonthlyPaise int64 = 39900
	studioMonthlyPaise  int64 = 49900
)

// LoadCatalog reads only provider identifiers and the platform account from
// environment. Prices, count and quantity remain code-owned so an accidental
// environment edit cannot turn a public request into an arbitrary recurring
// charge. Missing identifiers intentionally produce an empty catalog and the
// HTTP boundary fails closed with 503 until billing is configured.
func LoadCatalog(environment string, lookup func(string) string) MapCatalog {
	if environment != "test" && environment != "live" {
		return MapCatalog{}
	}
	env := strings.ToUpper(environment)
	accountRef := strings.TrimSpace(lookup("RAZORPAY_PLATFORM_ACCOUNT_REF_" + env))
	if accountRef == "" {
		return MapCatalog{}
	}
	catalog := MapCatalog{}
	for _, entry := range []struct {
		tier, interval string
		price          int64
		count          int
	}{
		{tier: "pro", interval: "monthly", price: proMonthlyPaise, count: 12},
		{tier: "creator", interval: "monthly", price: creatorMonthlyPaise, count: 12},
		{tier: "studio", interval: "monthly", price: studioMonthlyPaise, count: 12},
		// The persisted price is the monthly-equivalent price required by the
		// billing projection. The annual Razorpay plan ID carries the actual
		// ten-month charge; the HTTP response exposes both values.
		{tier: "pro", interval: "annual", price: proMonthlyPaise, count: 1},
		{tier: "creator", interval: "annual", price: creatorMonthlyPaise, count: 1},
		{tier: "studio", interval: "annual", price: studioMonthlyPaise, count: 1},
	} {
		planID := strings.TrimSpace(lookup(fmt.Sprintf("RAZORPAY_PLAN_%s_%s_%s", strings.ToUpper(entry.tier), strings.ToUpper(entry.interval), env)))
		if planID == "" {
			return MapCatalog{}
		}
		catalog[environment+":"+entry.tier+":"+entry.interval] = Plan{
			ProviderAccountScope: "platform",
			ProviderAccountRef:   accountRef,
			ProviderPlanID:       planID,
			Tier:                 entry.tier,
			BillingInterval:      entry.interval,
			PricePaise:           entry.price,
			TotalCount:           entry.count,
			Quantity:             1,
			CustomerNotify:       true,
		}
	}
	return catalog
}

func EnvironmentCatalog(environment string) MapCatalog {
	return LoadCatalog(environment, os.Getenv)
}
