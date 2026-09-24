// Copy this file to config.js to connect Hooky to a real Supabase project.
// Without config.js the app runs in demo mode with local fake users.
//
// ONLY the publishable (anon) key belongs here. It is safe in public code
// because Row Level Security is what protects the data. NEVER put a
// service_role or secret key in this file: it bypasses Row Level Security and
// would expose every user's data to anyone who views the page source.
window.HOOKY_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-PUBLISHABLE-OR-ANON-KEY",
};
