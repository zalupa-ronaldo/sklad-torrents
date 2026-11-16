import { expect, it } from "vitest";

import { channelConfig, firstIpv4, parsePortproxy, portproxyHealthy } from "../../../agents/pc-agent/channel-probe.mjs";

const SHOW = [
  "",
  "Прослушивание ipv4:             Подключение к ipv4:",
  "",
  "Адрес          Порт        Адрес          Порт",
  "--------------- ----------  --------------- ----------",
  "127.0.0.1       18080       172.31.244.147  8080",
  "0.0.0.0         8080        172.31.244.147  8081",
  "",
].join("\r\n");

it("reads portproxy rows from localized netsh output", () => {
  expect(parsePortproxy(SHOW)).toEqual([
    { listenHost: "127.0.0.1", listenPort: 18080, connectHost: "172.31.244.147", connectPort: 8080 },
    { listenHost: "0.0.0.0", listenPort: 8080, connectHost: "172.31.244.147", connectPort: 8081 },
  ]);
});

it("treats the LAN forward to the current WSL address as healthy", () => {
  const cfg = channelConfig({});
  const rows = parsePortproxy(SHOW);
  expect(portproxyHealthy(rows, "172.31.244.147", cfg)).toBe(true);
  expect(portproxyHealthy(rows, "172.31.250.1", cfg)).toBe(false);
  expect(portproxyHealthy(rows, null, cfg)).toBe(false);
});

it("takes the first IPv4 from hostname -I", () => {
  expect(firstIpv4("172.31.244.147 fe80::1 \n")).toBe("172.31.244.147");
  expect(firstIpv4("")).toBeNull();
  expect(firstIpv4("999.1.1.1")).toBeNull();
});
