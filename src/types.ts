export type Bindings = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENCRYPTION_KEY: string;
  REDIRECT_URI?: string;
};

export interface UserToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}