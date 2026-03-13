export interface MessagingAdapter {
  notify(userId: string, message: string): Promise<void>;
  ping(userId: string, message: string): Promise<void>;
}
