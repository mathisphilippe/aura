<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { supabase } from '$lib/supabaseClient';

  let { children } = $props();
  let loading = $state(true);

  onMount(async () => {
    // Récupérer la session initiale
    const { data: { session } } = await supabase.auth.getSession();

    if (!session && page.url.pathname !== '/login') {
      goto('/login');
    }

    // Écouter les changements d'état (connexion/déconnexion)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (!currentSession && page.url.pathname !== '/login') {
        goto('/login');
      } else if (currentSession && page.url.pathname === '/login') {
        goto('/');
      }
    });

    loading = false;

    return () => {
      subscription.unsubscribe();
    };
  });
</script>

{#if loading}
  <div style="display: flex; height: 100vh; align-items: center; justify-content: center; font-family: sans-serif;">
    <p>Chargement de l'aura...</p>
  </div>
{:else}
  {@render children()}
{/if}