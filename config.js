// Live Supabase project for Hooky.
// ONLY the publishable key belongs here. It is safe in public client code
// because Row Level Security is what protects the data. NEVER put a
// service_role or secret key in this file.
window.HOOKY_CONFIG = {
  supabaseUrl: "https://hbaimmnilujvrabktccm.supabase.co",
  supabaseAnonKey: "sb_publishable_x1iwyVs_W1NWiFLqV_T3Eg_N0tLPUtd",
  // VAPID public key for Web Push. Public by design: it identifies the sender
  // and is useless without the matching private key, which lives only in the
  // push-send Edge Function secret.
  vapidPublicKey: "BDxR2oP2EWDiEMyqUJ_cFQGiv5dURUSRTWoV5lcJhKMGj6tcqeHgfNuWnjrXJrlitg_hWT3Ieg0dkidfeKK7FTM",
};
