import { json } from '@sveltejs/kit';
import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { createClient } from '@supabase/supabase-js';

export async function POST({ request }) {
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const vapidSubject = env.VAPID_SUBJECT || 'mailto:admin@aura.app';
  const vapidPublicKey = publicEnv.PUBLIC_VAPID_KEY;
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  // Utilise la clé Service Role si présente, sinon fallback sur la clé anonyme
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || publicEnv.PUBLIC_SUPABASE_ANON_KEY;

  if (!vapidPrivateKey || !vapidPublicKey) {
    return json({ success: false, error: 'VAPID keys not configured' }, { status: 500 });
  }

  // Client Supabase avec droits serveur
  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

  webpush.setVapidDetails(
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey
  );

  try {
    const { title, body, url, targetUserIds } = await request.json();

    let query = supabaseAdmin.from('push_subscriptions').select('subscription, user_id');
    if (targetUserIds && targetUserIds.length > 0) {
      query = query.in('user_id', targetUserIds);
    }

    const { data: subs, error } = await query;
    if (error) {
      return json({ success: false, error: error.message }, { status: 500 });
    }

    if (!subs || subs.length === 0) {
      return json({ success: false, message: 'Aucun abonnement trouvé en base' });
    }

    const pushOptions = {
      TTL: 60 * 60 * 24,
      urgency: 'high' as const
    };

    const notifications = subs.map(async (row) => {
      try {
        const subscriptionObj = typeof row.subscription === 'string'
          ? JSON.parse(row.subscription)
          : row.subscription;

        return await webpush.sendNotification(
          subscriptionObj,
          JSON.stringify({ 
            title: title || '⚡ Aura', 
            body: body || 'Nouveau vote disponible !', 
            url: url || '/' 
          }),
          pushOptions
        );
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabaseAdmin.from('push_subscriptions').delete().match({ subscription: row.subscription });
        }
        throw err;
      }
    });

    const results = await Promise.allSettled(notifications);
    return json({ success: true, count: subs.length, results });
  } catch (err: any) {
    return json({ success: false, error: err.message }, { status: 500 });
  }
}