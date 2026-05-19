export type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type: string; title?: string }
    from?: {
      id: number
      username?: string
      first_name?: string
      last_name?: string
    }
    text?: string
  }
  callback_query?: {
    id: string
    from: {
      id: number
      username?: string
      first_name?: string
      last_name?: string
    }
    message?: {
      message_id: number
      chat: { id: number; type: string }
    }
    data?: string
  }
}
