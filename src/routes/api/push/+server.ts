import { json } from '@sveltejs/kit';
import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { supabase } from '$lib/supabaseClient';

export async function POST({ request }) {
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const vapidSubject = env.VAPID_SUBJECT || 'mailto:admin@aura.app';
  const vapidPublicKey = publicEnv.PUBLIC_VAPID_KEY;

  if (!vapidPrivateKey || !vapidPublicKey) {
    return json({ success: false, error: 'VAPID keys not configured' }, { status: 500 });
  }

  webpush.setVapidDetails(
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey
  );

  try {
    const { title, body, url, targetUserIds } = await request.json();

    let query = supabase.from('push_subscriptions').select('subscription, user_id');
    if (targetUserIds && targetUserIds.length > 0) {
      query = query.in('user_id', targetUserIds);
    }

    const { data: subs, error } = await query;
    if (error || !subs) return json({ success: false, error }, { status: 500 });

    const notifications = subs.map(async (row) => {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({ title, body, url })
        );
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().match({ subscription: row.subscription });
        }
      }
    });

    await Promise.allSettled(notifications);
    return json({ success: true });
  } catch (err: any) {
    return json({ success: false, error: err.message }, { status: 500 });
  }
}