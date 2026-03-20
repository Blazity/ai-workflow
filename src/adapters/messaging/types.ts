export interface MessagingAdapter {
  notify(message: string): Promise<void>;
}
