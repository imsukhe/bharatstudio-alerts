# syntax=docker/dockerfile:1
#
# NOTE: unlike the other Go services in this repo, the base images below are
# referenced by tag, not a verified digest — no digest-pinning review has
# been done for this new service. Pin to a specific digest as part of this
# service's own image-verification pass before relying on this Dockerfile
# for a production build.
FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o /out/youtube-poller ./cmd/youtube-poller

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/youtube-poller /youtube-poller

USER nonroot:nonroot
ENTRYPOINT ["/youtube-poller"]
