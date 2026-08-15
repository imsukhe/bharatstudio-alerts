package webhook

import (
	"errors"
	"testing"
)

func TestParsePaymentCapturedNormalizesOnlyRequiredFields(t *testing.T) {
	event, err := ParseEvent([]byte(`{"entity":"event","account_id":"acc_test","created_at":1700000000,"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_123","amount":5000,"currency":"INR","status":"captured","order_id":"order_123","future_provider_field":"ignored"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.EntityType != "payment" || event.EntityID != "pay_123" || event.PaymentID != "pay_123" || event.OrderID != "order_123" || event.AmountPaise != 5000 || event.Currency != "INR" || event.AccountID != "acc_test" {
		t.Fatalf("unexpected normalized event: %#v", event)
	}
}

func TestParseRefundUsesRefundEntityAndPaymentReference(t *testing.T) {
	event, err := ParseEvent([]byte(`{"event":"refund.processed","payload":{"refund":{"entity":{"id":"rfnd_123","amount":1000,"currency":"INR","payment_id":"pay_123","status":"processed"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.EntityType != "refund" || event.EntityID != "rfnd_123" || event.PaymentID != "pay_123" || event.RefundAmount != 1000 {
		t.Fatalf("unexpected refund event: %#v", event)
	}
}

func TestParseDisputeUsesDisputeEntityAndPaymentReference(t *testing.T) {
	event, err := ParseEvent([]byte(`{"event":"payment.dispute.created","payload":{"dispute":{"entity":{"entity":"dispute","id":"disp_123","amount":5000,"currency":"INR","payment_id":"pay_123","status":"open"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.EntityType != "dispute" || event.EntityID != "disp_123" || event.PaymentID != "pay_123" || event.AmountPaise != 5000 || event.Currency != "INR" {
		t.Fatalf("unexpected dispute event: %#v", event)
	}
}

func TestParseSubscriptionNormalizesPlanAndPeriodFields(t *testing.T) {
	event, err := ParseEvent([]byte(`{"event":"subscription.activated","account_id":"acc_test","payload":{"subscription":{"entity":{"entity":"subscription","id":"sub_123","plan_id":"plan_creator_monthly","status":"active","current_start":1700000000,"current_end":1702592000,"charge_at":1702592000}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.EntityType != "subscription" || event.EntityID != "sub_123" || event.PlanID != "plan_creator_monthly" || event.CurrentStart != 1700000000 || event.CurrentEnd != 1702592000 || event.ChargeAt != 1702592000 {
		t.Fatalf("unexpected normalized subscription: %#v", event)
	}
}

func TestParseEventRejectsMalformedUnsupportedMissingAndTrailingPayloads(t *testing.T) {
	cases := []struct {
		name string
		body string
		err  error
	}{
		{"malformed", `{`, ErrMalformedPayload},
		{"unsupported", `{"event":"invoice.paid","payload":{}}`, ErrUnsupportedEvent},
		{"missing entity", `{"event":"payment.captured","payload":{}}`, ErrMissingEntity},
		{"trailing", `{"event":"payment.captured","payload":{}} {}`, ErrMalformedPayload},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ParseEvent([]byte(testCase.body))
			if !errors.Is(err, testCase.err) {
				t.Fatalf("error = %v, want %v", err, testCase.err)
			}
		})
	}
}
