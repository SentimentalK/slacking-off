export function defaultInstallTab(platform: string): 'sh' | 'ps1' {
  return /win/i.test(platform) ? 'ps1' : 'sh';
}
