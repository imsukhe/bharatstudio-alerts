package tasks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	ActionDeliverOverlay = "deliver_overlay"
	maxTaskBodyBytes     = 64 << 10
)

var (
	ErrInvalidEnqueuer  = errors.New("invalid cloud tasks enqueuer")
	ErrTaskBodyTooLarge = errors.New("cloud task body too large")
)

// Task is the provider-neutral request needed to create one Cloud Task. The
// concrete client owns Google credentials and API calls; command data never
// contains provider credentials.
type Task struct {
	Queue              string
	Name               string
	TargetURL          string
	OIDCAudience       string
	Body               []byte
	OIDCServiceAccount string
}

type Client interface {
	CreateTask(context.Context, Task) error
}

type Enqueuer struct {
	client             Client
	queue              string
	targetURL          string
	oidcAudience       string
	oidcServiceAccount string
}

func NewEnqueuer(client Client, queue, targetURL, oidcAudience, oidcServiceAccount string) (Enqueuer, error) {
	parsed, err := url.Parse(targetURL)
	if client == nil || strings.TrimSpace(queue) == "" || err != nil || parsed.Scheme != "https" || parsed.Host == "" || strings.TrimSpace(oidcAudience) == "" || strings.TrimSpace(oidcServiceAccount) == "" {
		return Enqueuer{}, ErrInvalidEnqueuer
	}
	return Enqueuer{
		client:             client,
		queue:              queue,
		targetURL:          targetURL,
		oidcAudience:       oidcAudience,
		oidcServiceAccount: oidcServiceAccount,
	}, nil
}

func (e Enqueuer) Enqueue(ctx context.Context, command Command) error {
	if command.Action != ActionDeliverOverlay {
		return ErrInvalidCommand
	}
	if err := command.Validate(time.Now()); err != nil {
		return err
	}
	body, err := json.Marshal(command)
	if err != nil {
		return fmt.Errorf("marshal cloud task command: %w", err)
	}
	if len(body) > maxTaskBodyBytes {
		return ErrTaskBodyTooLarge
	}
	key := sha256.Sum256([]byte(command.IdempotencyKey()))
	task := Task{
		Queue:              e.queue,
		Name:               e.queue + "/tasks/bsa-" + hex.EncodeToString(key[:]),
		TargetURL:          e.targetURL,
		OIDCAudience:       e.oidcAudience,
		Body:               append([]byte(nil), body...),
		OIDCServiceAccount: e.oidcServiceAccount,
	}
	if err := e.client.CreateTask(ctx, task); err != nil && !isAlreadyExists(err) {
		return err
	}
	return nil
}

type alreadyExistsError interface {
	AlreadyExists() bool
}

func isAlreadyExists(err error) bool {
	var marker alreadyExistsError
	return errors.As(err, &marker) && marker.AlreadyExists()
}
