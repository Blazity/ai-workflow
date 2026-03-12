export interface MessagingAdapter {
  sendNotification(channel: string, message: string): Promise<void>;
}
