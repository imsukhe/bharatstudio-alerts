package tasks

import (
	"context"

	cloudtasks "cloud.google.com/go/cloudtasks/apiv2"
	"cloud.google.com/go/cloudtasks/apiv2/cloudtaskspb"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// GoogleCloudTasksClient is the production adapter for the provider-neutral
// tasks.Client contract. It uses Application Default Credentials supplied by
// the Cloud Run service identity; credentials are never read from a task body.
type GoogleCloudTasksClient struct {
	client *cloudtasks.Client
}

func NewGoogleCloudTasksClient(ctx context.Context, options ...option.ClientOption) (*GoogleCloudTasksClient, error) {
	client, err := cloudtasks.NewClient(ctx, options...)
	if err != nil {
		return nil, err
	}
	return &GoogleCloudTasksClient{client: client}, nil
}

func (c *GoogleCloudTasksClient) Close() error {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Close()
}

func (c *GoogleCloudTasksClient) CreateTask(ctx context.Context, task Task) error {
	if c == nil || c.client == nil {
		return ErrInvalidEnqueuer
	}
	request, err := buildCreateTaskRequest(task)
	if err != nil {
		return err
	}
	_, err = c.client.CreateTask(ctx, request)
	if status.Code(err) == codes.AlreadyExists {
		return cloudTaskAlreadyExistsError{}
	}
	return err
}

// buildCreateTaskRequest keeps the route URL and token audience independent:
// the URL selects the private handler route, while the audience is the
// canonical value verified by that service.
func buildCreateTaskRequest(task Task) (*cloudtaskspb.CreateTaskRequest, error) {
	if task.Queue == "" || task.Name == "" || task.TargetURL == "" || task.OIDCAudience == "" || task.OIDCServiceAccount == "" || len(task.Body) == 0 || len(task.Body) > maxTaskBodyBytes {
		return nil, ErrInvalidEnqueuer
	}
	return &cloudtaskspb.CreateTaskRequest{
		Parent: task.Queue,
		Task: &cloudtaskspb.Task{
			Name: task.Name,
			MessageType: &cloudtaskspb.Task_HttpRequest{
				HttpRequest: &cloudtaskspb.HttpRequest{
					Url:        task.TargetURL,
					HttpMethod: cloudtaskspb.HttpMethod_POST,
					Headers:    map[string]string{"Content-Type": "application/json"},
					Body:       append([]byte(nil), task.Body...),
					AuthorizationHeader: &cloudtaskspb.HttpRequest_OidcToken{
						OidcToken: &cloudtaskspb.OidcToken{
							ServiceAccountEmail: task.OIDCServiceAccount,
							Audience:            task.OIDCAudience,
						},
					},
				},
			},
		},
	}, nil
}

type cloudTaskAlreadyExistsError struct{}

func (cloudTaskAlreadyExistsError) Error() string       { return "cloud task already exists" }
func (cloudTaskAlreadyExistsError) AlreadyExists() bool { return true }

var _ Client = (*GoogleCloudTasksClient)(nil)
var _ alreadyExistsError = cloudTaskAlreadyExistsError{}
