package subscription

import "testing"

func TestLoadCatalogRequiresCompleteEnvironmentSpecificProviderMapping(t *testing.T) {
	values := map[string]string{
		"RAZORPAY_PLATFORM_ACCOUNT_REF_TEST": "acct_test",
	}
	for _, tier := range []string{"PRO", "CREATOR", "STUDIO"} {
		for _, interval := range []string{"MONTHLY", "ANNUAL"} {
			values["RAZORPAY_PLAN_"+tier+"_"+interval+"_TEST"] = "plan_" + tier + "_" + interval
		}
	}
	catalog := LoadCatalog("test", func(key string) string { return values[key] })
	if len(catalog) != 6 {
		t.Fatalf("catalog entries=%d", len(catalog))
	}
	if plan, ok := catalog["test:creator:monthly"]; !ok || plan.PricePaise != 39900 || plan.TotalCount != 12 || plan.ProviderAccountScope != "platform" {
		t.Fatalf("monthly creator plan=%#v ok=%v", plan, ok)
	}
	if plan, ok := catalog["test:studio:annual"]; !ok || plan.PricePaise != 49900 || plan.TotalCount != 1 {
		t.Fatalf("annual studio plan=%#v ok=%v", plan, ok)
	}
	delete(values, "RAZORPAY_PLAN_STUDIO_ANNUAL_TEST")
	if incomplete := LoadCatalog("test", func(key string) string { return values[key] }); len(incomplete) != 0 {
		t.Fatalf("partial catalog should fail closed: %#v", incomplete)
	}
}
