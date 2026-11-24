export function isWebClient(): boolean {
  return !window.octopusTransport && (window.location.protocol === "https:" || window.location.protocol === "http:");
}

export function isAgentWebClient(): boolean {
  return isWebClient() && !import.meta.env.DEV;
}
