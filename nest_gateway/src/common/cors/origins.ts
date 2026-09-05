interface GatewayOriginOptions {
  bindHost: string;
  port: number;
  hostName?: string;
  interfaceAddresses?: string[];
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function buildGatewayOrigins({
  bindHost,
  port,
  hostName,
  interfaceAddresses = [],
}: GatewayOriginOptions): string[] {
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::';
  const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);

  if (!wildcard) hosts.add(bindHost);
  if (wildcard) {
    if (hostName) hosts.add(hostName);
    for (const address of interfaceAddresses) {
      if (address) hosts.add(address.split('%')[0]);
    }
  }

  return [...hosts].flatMap((host) => {
    const formatted = urlHost(host);
    return [`http://${formatted}:${port}`, `https://${formatted}:${port}`];
  });
}
