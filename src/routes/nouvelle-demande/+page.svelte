<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { supabase } from '$lib/supabaseClient';

  type Profile = {
    id: string;
    username: string;
  };

  let targetUsers = $state<Profile[]>([]);
  let currentUserId = $state<string | null>(null);
  let selectedTargetId = $state<string>('');
  let description = $state<string>('');
  let fileToUpload = $state<File | null>(null);

  let loading = $state(false);
  let initialLoading = $state(true);
  let errorMessage = $state<string>('');

  onMount(async () => {
    // 1. Récupérer l'utilisateur actuel
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      goto('/login');
      return;
    }
    currentUserId = session.user.id;

    // 2. Récupérer la liste des cibles potentielles (sauf soi-même)
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username')
      .neq('id', currentUserId)
      .order('username', { ascending: true });

    if (error) {
      errorMessage = error.message;
    } else if (data) {
      targetUsers = data;
    }

    initialLoading = false;
  });

  function handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      fileToUpload = input.files[0];
    }
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (!selectedTargetId || !description.trim() || !currentUserId) {
      errorMessage = 'Merci de sélectionner une cible et de mettre un motif.';
      return;
    }

    loading = true;
    errorMessage = '';

    try {
      let mediaUrl: string | null = null;

      // 1. Upload du média si présent
      if (fileToUpload) {
        const fileExt = fileToUpload.name.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;
        const filePath = `${currentUserId}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('aura_media')
          .upload(filePath, fileToUpload);

        if (uploadError) throw uploadError;

        // Récupérer l'URL publique
        const { data: urlData } = supabase.storage
          .from('aura_media')
          .getPublicUrl(filePath);

        mediaUrl = urlData.publicUrl;
      }

      // 2. Insérer la demande d'Aura
      const { error: insertError } = await supabase
        .from('aura_requests')
        .insert({
          creator_id: currentUserId,
          target_id: selectedTargetId,
          description: description.trim(),
          media_url: mediaUrl
        });

      if (insertError) throw insertError;

      // Redirection vers le dashboard
      goto('/');
    } catch (err: any) {
      errorMessage = err.message || "Erreur lors de la création de la demande.";
    } finally {
      loading = false;
    }
  }
</script>

<div class="container">
  <div class="top-nav">
    <a href="/" class="btn-back">← Annuler</a>
  </div>

  <h1>⚡ Demande d'Aura</h1>
  <p class="subtitle">Soumets une action au vote du tribunal populaire.</p>

  {#if initialLoading}
    <p class="loading">Chargement des membres...</p>
  {:else}
    {#if errorMessage}
      <div class="alert-error">
        {errorMessage}
      </div>
    {/if}

    <form onsubmit={handleSubmit} class="form">
      <!-- Sélection de la cible -->
      <div class="form-group">
        <label for="target">Membre ciblé</label>
        <select id="target" bind:value={selectedTargetId} required>
          <option value="" disabled selected>Sélectionne un pote...</option>
          {#each targetUsers as user}
            <option value={user.id}>{user.username}</option>
          {/each}
        </select>
      </div>

      <!-- Description / Preuve textuelle -->
      <div class="form-group">
        <label for="description">Motif de l'aura (action héroïque ou honte)</label>
        <textarea
          id="description"
          bind:value={description}
          rows="4"
          placeholder="Ex: A lavé la vaisselle de toute la coloc sans qu'on lui demande / S'est endormi en boîte..."
          required
        ></textarea>
      </div>

      <!-- Upload photo ou vidéo -->
      <div class="form-group">
        <label for="media">Preuve visuelle (optionnel — photo ou vidéo)</label>
        <input
          id="media"
          type="file"
          accept="image/*,video/*"
          onchange={handleFileChange}
        />
      </div>

      <!-- Bouton validation -->
      <button type="submit" class="btn-submit" disabled={loading}>
        {loading ? 'Publication en cours...' : 'Lancer le vote (2h)'}
      </button>
    </form>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background-color: #0f172a;
    color: #f8fafc;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .container {
    max-width: 500px;
    margin: 0 auto;
    padding: 20px 16px 40px;
  }
  .top-nav {
    margin-bottom: 16px;
  }
  .btn-back {
    color: #94a3b8;
    text-decoration: none;
    font-size: 14px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 1.5rem;
  }
  .subtitle {
    margin: 0 0 24px;
    font-size: 14px;
    color: #94a3b8;
  }
  .alert-error {
    background: #fee2e2;
    color: #b91c1c;
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 20px;
    font-size: 14px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    font-size: 14px;
    font-weight: bold;
    color: #e2e8f0;
  }
  select, textarea, input[type="file"] {
    background: #1e293b;
    border: 1px solid #334155;
    color: #f8fafc;
    padding: 12px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 14px;
    box-sizing: border-box;
    width: 100%;
  }
  select:focus, textarea:focus {
    outline: 2px solid #6366f1;
  }
  input[type="file"] {
    padding: 10px;
    color: #94a3b8;
  }
  .btn-submit {
    background: #6366f1;
    color: white;
    padding: 14px;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    margin-top: 8px;
    transition: 0.2s;
  }
  .btn-submit:hover:not(:disabled) {
    background: #4f46e5;
  }
  .btn-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .loading {
    text-align: center;
    color: #94a3b8;
    margin-top: 40px;
  }
</style>