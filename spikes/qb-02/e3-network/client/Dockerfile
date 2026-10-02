# E3 test client and fixtures: the untrusted consumer (curl + the in-container
# socket forwarder), the test resolver (dnsmasq) and the internal canary (socat).
FROM alpine:3.20
RUN apk add --no-cache curl socat bind-tools dnsmasq
