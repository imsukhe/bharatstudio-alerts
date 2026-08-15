# syntax=docker/dockerfile:1

# Pin both stages to the digests resolved by the 2026-08-15 verified build.
FROM golang:1.26-alpine@sha256:70b46548e42db77e0966aaf3619fd068734dc6c77584d526b91126504fd95816 AS build

WORKDIR /src

# Keep dependency resolution cacheable while making the source boundary explicit.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o /out/payment-webhook ./cmd/payment-webhook

FROM gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a

COPY --from=build /out/payment-webhook /payment-webhook

USER nonroot:nonroot
ENTRYPOINT ["/payment-webhook"]
