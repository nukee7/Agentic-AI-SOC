export interface SecurityEvent {

  timestamp: string

  user: string

  sourceIp: string

  loginStatus: "SUCCESS" | "FAILED"

  service: string

}