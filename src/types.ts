export interface GaugeConfig {
  gaugeAddress: string
  rewardToken: string
  hoursBefore: number
  userToPing: string
}

export interface GroupConfig {
  gauges: GaugeConfig[]
}

export interface AllConfig {
  [chatId: string]: GroupConfig
}
