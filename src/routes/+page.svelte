<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabaseClient';
  import { goto } from '$app/navigation';
  import { env } from '$env/dynamic/public';

  type Profile = {
    id: string;
    username: string;
    avatar_url: string | null;
    is_coloc: boolean;
    aura_score: number;
    all_time_aura?: number;
  };

  type AuraRequest = {
    id: string;
    description: string;
    media_url: string | null;
    expires_at: string;
    created_at: string;
    status: string;
    creator_id: string;
    target_id: string;
    target: { username: string; avatar_url: string | null };
    creator: { username: string };
    votes: { voter_id: string; vote_type: string }[];
    delta?: number;
  };

  type SeasonArchive = {
    month_label: string;
    winner: { username: string; avatar_url: string | null };
    winner_score: number;
    loser: { username: string; avatar_url: string | null };
    loser_score: number;
  };

  // Navigation par onglets
  let currentTab = $state<'feed' | 'create' | 'leaderboard' | 'profile'>('feed');
  let mainLeaderboard = $state<'coloc' | 'all' | 'monthly'>('coloc');
  let subLeaderboardTime = $state<'month' | 'alltime'>('month');

  let currentUserId = $state<string | null>(null);
  let myProfile = $state<Profile | null>(null);
  let profiles = $state<Profile[]>([]);
  let activeRequests = $state<AuraRequest[]>([]);
  let resolvedMonthlyRequests = $state<AuraRequest[]>([]);
  let lastSeason = $state<SeasonArchive | null>(null);
  let loading = $state(true);

  // Pull-to-refresh
  let mainContainer = $state<HTMLElement | null>(null);
  let pullStartY = 0;
  let pullDistance = $state(0);
  let isRefreshing = $state(false);

  // Formulaire Demande
  let targetUsers = $state<Profile[]>([]);
  let selectedTargetId = $state<string>('');
  let description = $state<string>('');
  let fileToUpload = $state<File | null>(null);
  let isSubmitting = $state(false);
  let createError = $state('');

  // Formulaire Profil
  let newUsername = $state('');
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);
  let isUpdatingProfile = $state(false);
  let profileMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  // Notifications push state
  let isPushSubscribed = $state(false);
  let pushLoading = $state(false);

  // Lightbox & Téléchargement
  let modalMediaUrl = $state<string | null>(null);
  let isDownloading = $state(false);

  // Gestion du son vidéo
  let unmutedVideoId = $state<string | null>(null);

  // Profils filtrés et ordonnés
  let displayedProfiles = $derived.by(() => {
    let list = mainLeaderboard === 'coloc'
      ? profiles.filter(p => p.is_coloc)
      : profiles;

    return [...list].sort((a, b) => {
      if (subLeaderboardTime === 'alltime') {
        return (b.all_time_aura ?? 100) - (a.all_time_aura ?? 100);
      }
      return b.aura_score - a.aura_score;
    });
  });

  let myRank = $derived(
    profiles.findIndex(p => p.id === currentUserId) + 1
  );

  let top3Requests = $derived(
    [...resolvedMonthlyRequests]
      .filter(r => (r.delta ?? 0) > 0)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
      .slice(0, 3)
  );

  let flop3Requests = $derived(
    [...resolvedMonthlyRequests]
      .filter(r => (r.delta ?? 0) < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .slice(0, 3)
  );

  function isVideo(url: string | null) {
    if (!url) return false;
    return url.match(/\.(mp4|webm|ogg|mov)$/i) !== null;
  }

  // Pull-to-refresh handlers
  function handleTouchStart(e: TouchEvent) {
    if (!mainContainer || mainContainer.scrollTop > 0 || isRefreshing) return;
    pullStartY = e.touches[0].clientY;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!mainContainer || mainContainer.scrollTop > 0 || isRefreshing || pullStartY === 0) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - pullStartY;

    if (diff > 0) {
      pullDistance = Math.min(diff * 0.45, 80);
    }
  }

  async function handleTouchEnd() {
    if (pullDistance >= 55 && !isRefreshing) {
      isRefreshing = true;
      pullDistance = 50;
      await loadData();
      isRefreshing = false;
    }
    pullStartY = 0;
    pullDistance = 0;
  }

  // Compression automatique des photos dans le navigateur
  async function compressImageClient(file: File): Promise<File> {
    if (!file.type.startsWith('image/')) return file;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (e) => {
        const img = new Image();
        img.src = e.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 1200;
          let width = img.width;
          let height = img.height;

          if (width > MAX_WIDTH) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            if (blob) {
              resolve(new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' }));
            } else {
              resolve(file);
            }
          }, 'image/jpeg', 0.82);
        };
      };
    });
  }

  function checkVideoDuration(file: File): Promise<boolean> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        window.URL.revokeObjectURL(video.src);
        resolve(video.duration <= 32);
      };
      video.onerror = () => resolve(true);
      video.src = URL.createObjectURL(file);
    });
  }

  // Téléchargement direct vers la pellicule
  async function downloadCurrentMedia() {
    if (!modalMediaUrl) return;
    isDownloading = true;

    try {
      const response = await fetch(modalMediaUrl);
      const blob = await response.blob();
      const ext = modalMediaUrl.split('.').pop()?.split('?')[0] || (isVideo(modalMediaUrl) ? 'mp4' : 'jpg');
      const file = new File([blob], `aura_${Date.now()}.${ext}`, { type: blob.type });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Aura Media'
        });
      } else {
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `aura_${Date.now()}.${ext}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      }
    } catch {
      window.open(modalMediaUrl, '_blank');
    } finally {
      isDownloading = false;
    }
  }

  function toggleVideoSound(e: Event, reqId: string) {
    e.stopPropagation();
    if (unmutedVideoId === reqId) {
      unmutedVideoId = null;
    } else {
      unmutedVideoId = reqId;
    }
  }

  // Vérification et activation des notifications push
  async function checkPushSubscription() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        isPushSubscribed = !!sub;
      }
    }
  }

function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

async function handleTogglePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert("Les notifications ne sont pas supportées sur ce navigateur.");
      return;
    }

    pushLoading = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert("Permission de notification refusée dans les réglages.");
        pushLoading = false;
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
      }

      const vapidKey = env.PUBLIC_VAPID_KEY;
      if (!vapidKey) {
        throw new Error("Clé publique VAPID manquante dans l'environnement.");
      }

      const convertedVapidKey = urlBase64ToUint8Array(vapidKey);

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey
      });

      const { error } = await supabase.from('push_subscriptions').upsert({
        user_id: currentUserId,
        subscription: subscription.toJSON()
      });

      if (error) throw error;

      isPushSubscribed = true;
      alert("Notifications activées avec succès ! 🔔");
    } catch (err: any) {
      alert("Erreur activation : " + (err.message || 'Échec'));
    } finally {
      pushLoading = false;
    }
  }

  async function loadData() {
    loading = true;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      goto('/login');
      return;
    }
    currentUserId = session.user.id;

    await supabase.rpc('resolve_expired_aura_requests');
    await supabase.rpc('check_and_reset_monthly_aura');

    // 1. Profils
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('*')
      .order('aura_score', { ascending: false });

    if (profilesData) {
      profiles = profilesData;
      targetUsers = profilesData;
      myProfile = profilesData.find(p => p.id === currentUserId) || null;
      if (myProfile) {
        newUsername = myProfile.username;
        avatarPreview = myProfile.avatar_url;
      }
    }

    // 2. Demandes actives
    const { data: requestsData } = await supabase
      .from('aura_requests')
      .select(`
        id,
        description,
        media_url,
        expires_at,
        created_at,
        status,
        creator_id,
        target_id,
        target:profiles!aura_requests_target_id_fkey(username, avatar_url),
        creator:profiles!aura_requests_creator_id_fkey(username),
        votes(voter_id, vote_type)
      `)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (requestsData) {
      activeRequests = requestsData as unknown as AuraRequest[];
    }

    // 3. Demandes résolues (30 derniers jours)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: monthlyData } = await supabase
      .from('aura_requests')
      .select(`
        id,
        description,
        media_url,
        expires_at,
        created_at,
        status,
        creator_id,
        target_id,
        target:profiles!aura_requests_target_id_fkey(username, avatar_url),
        creator:profiles!aura_requests_creator_id_fkey(username),
        votes(voter_id, vote_type)
      `)
      .eq('status', 'resolved')
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (monthlyData) {
      resolvedMonthlyRequests = (monthlyData as unknown as AuraRequest[]).map(req => {
        const ups = req.votes?.filter(v => v.vote_type === 'up').length || 0;
        const downs = req.votes?.filter(v => v.vote_type === 'down').length || 0;
        return {
          ...req,
          delta: (ups - downs) * 10
        };
      });
    }

    // 4. Archive du mois précédent
    const { data: seasonData } = await supabase
      .from('monthly_seasons')
      .select(`
        month_label,
        winner_score,
        loser_score,
        winner:profiles!monthly_seasons_winner_id_fkey(username, avatar_url),
        loser:profiles!monthly_seasons_loser_id_fkey(username, avatar_url)
      `)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (seasonData) {
      lastSeason = seasonData as unknown as SeasonArchive;
    }

    await checkPushSubscription();
    loading = false;
  }

async function handleVote(requestId: string, voteType: 'up' | 'down') {
    if (!currentUserId) return;

    const requestIndex = activeRequests.findIndex(r => r.id === requestId);
    if (requestIndex === -1) return;

    const request = activeRequests[requestIndex];

    if (request.target_id === currentUserId) {
      alert("Tu ne peux pas voter pour ton propre dossier !");
      return;
    }

    // Sauvegarde de l'état pour rollback en cas d'erreur réseau
    const previousVotes = [...(request.votes || [])];
    const existingVoteIndex = previousVotes.findIndex(v => v.voter_id === currentUserId);
    const existingVote = existingVoteIndex !== -1 ? previousVotes[existingVoteIndex] : null;

    let updatedVotes = [...previousVotes];
    let action: 'delete' | 'update' | 'insert';

    // 1. Mise à jour optimiste immédiate dans l'interface (zéro chargement)
    if (existingVote) {
      if (existingVote.vote_type === voteType) {
        updatedVotes.splice(existingVoteIndex, 1);
        action = 'delete';
      } else {
        updatedVotes[existingVoteIndex] = { ...existingVote, vote_type: voteType };
        action = 'update';
      }
    } else {
      updatedVotes.push({ voter_id: currentUserId, vote_type: voteType });
      action = 'insert';
    }

    // Mise à jour réactive sans toucher à "loading"
    activeRequests[requestIndex] = {
      ...request,
      votes: updatedVotes
    };

    // 2. Exécution de la requête Supabase en tâche de fond
    try {
      if (action === 'delete') {
        const { error } = await supabase
          .from('votes')
          .delete()
          .match({ request_id: requestId, voter_id: currentUserId });
        if (error) throw error;
      } else if (action === 'update') {
        const { error } = await supabase
          .from('votes')
          .update({ vote_type: voteType })
          .match({ request_id: requestId, voter_id: currentUserId });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('votes')
          .insert({
            request_id: requestId,
            voter_id: currentUserId,
            vote_type: voteType
          });
        if (error) throw error;
      }
    } catch (err: any) {
      // Rollback discret en cas d'échec
      activeRequests[requestIndex] = {
        ...request,
        votes: previousVotes
      };
      alert(err.message || 'Erreur lors du vote.');
    }
  }

  async function handleCreateRequest(e: Event) {
    e.preventDefault();
    if (!selectedTargetId || !description.trim() || !currentUserId) return;

    isSubmitting = true;
    createError = '';

    try {
      let mediaUrl: string | null = null;

      if (fileToUpload) {
        if (fileToUpload.type.startsWith('video/')) {
          const isValid = await checkVideoDuration(fileToUpload);
          if (!isValid) {
            throw new Error("La vidéo ne doit pas dépasser 30 secondes !");
          }
        }

        const fileToProcess = await compressImageClient(fileToUpload);
        const fileExt = fileToProcess.name.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;
        const filePath = `posts/${currentUserId}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('aura_media')
          .upload(filePath, fileToProcess);

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('aura_media')
          .getPublicUrl(filePath);

        mediaUrl = urlData.publicUrl;
      }

      const { error: insertError } = await supabase
        .from('aura_requests')
        .insert({
          creator_id: currentUserId,
          target_id: selectedTargetId,
          description: description.trim(),
          media_url: mediaUrl
        });

      if (insertError) throw insertError;

      // Déclenchement automatique des notifications push
      const targetUser = targetUsers.find(u => u.id === selectedTargetId);
      fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: "⚡ C'est l'heure de l'AURA !",
          body: `Un vote a été lancé sur ${targetUser?.username || 'un membre'} : « ${description.trim().substring(0, 60)}... »`,
          url: '/'
        })
      }).catch(() => {});

      selectedTargetId = '';
      description = '';
      fileToUpload = null;
      currentTab = 'feed';
      await loadData();
    } catch (err: any) {
      createError = err.message || 'Erreur lors de la création.';
    } finally {
      isSubmitting = false;
    }
  }

  async function handleAvatarSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const file = target.files[0];
      const compressed = await compressImageClient(file);
      avatarFile = compressed;
      avatarPreview = URL.createObjectURL(compressed);
    }
  }

  async function handleUpdateProfile(e: Event) {
    e.preventDefault();
    if (!currentUserId || !newUsername.trim()) return;

    isUpdatingProfile = true;
    profileMessage = null;

    try {
      let avatarUrl = myProfile?.avatar_url || null;

      if (avatarFile) {
        const fileExt = avatarFile.name.split('.').pop();
        const filePath = `avatars/${currentUserId}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('aura_media')
          .upload(filePath, avatarFile, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('aura_media')
          .getPublicUrl(filePath);

        avatarUrl = urlData.publicUrl;
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          username: newUsername.trim(),
          avatar_url: avatarUrl
        })
        .eq('id', currentUserId);

      if (updateError) throw updateError;

      profileMessage = { type: 'success', text: 'Profil mis à jour avec succès !' };
      await loadData();
    } catch (err: any) {
      profileMessage = { type: 'error', text: err.message || 'Erreur de mise à jour' };
    } finally {
      isUpdatingProfile = false;
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    goto('/login');
  }

  function getTimeRemaining(expiresAt: string) {
    const diff = new Date(expiresAt).getTime() - new Date().getTime();
    if (diff <= 0) return 'Terminé';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  onMount(() => {
    loadData();
  });
</script>

<div class="app-layout">
  <!-- Top App Bar -->
  <header class="top-bar">
    <div class="logo">⚡ <span>AURA CHANZY</span></div>
    
    <button 
      class="profile-header-btn {currentTab === 'profile' ? 'active' : ''}" 
      onclick={() => currentTab = 'profile'} 
      title="Mon profil"
    >
      {#if myProfile?.avatar_url}
        <img src={myProfile.avatar_url} alt="Avatar" class="header-avatar" />
      {:else}
        <div class="header-avatar-placeholder">
          {myProfile?.username ? myProfile.username.charAt(0).toUpperCase() : '👤'}
        </div>
      {/if}
    </button>
  </header>

  <!-- Contenu Principal avec Pull-to-refresh -->
  <main 
    class="main-content"
    bind:this={mainContainer}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
  >
    <!-- Indicateur Pull to Refresh -->
    {#if pullDistance > 0 || isRefreshing}
      <div class="pull-indicator" style="transform: translateY({pullDistance}px)">
        {#if isRefreshing}
          <div class="pull-spinner"></div>
        {:else}
          <div class="pull-arrow" style="transform: rotate({Math.min(pullDistance * 3.6, 180)}deg)">
            ↓
          </div>
        {/if}
      </div>
    {/if}

    {#if loading && !isRefreshing}
      <div class="center-state">
        <div class="spinner"></div>
      </div>

    <!-- 1. FEED D'ACCUEIL -->
    {:else if currentTab === 'feed'}
      {#if lastSeason}
        <div class="season-banner">
          <div class="season-badge king">
            👑 Roi du mois passé : <strong>{lastSeason.winner?.username}</strong> ({lastSeason.winner_score} pts)
          </div>
          <div class="season-badge trash">
            💀 Pire honte : <strong>{lastSeason.loser?.username}</strong> ({lastSeason.loser_score} pts)
          </div>
        </div>
      {/if}

      {#if activeRequests.length === 0}
        <div class="center-state">
          <p class="empty-title">Aucun jugement en cours</p>
          <p class="empty-sub">Tout le monde est sage... pour l'instant.</p>
          <button class="btn-action-feed" onclick={() => currentTab = 'create'}>Balancer un dossier</button>
        </div>
      {:else}
        <div class="feed-list">
          {#each activeRequests as req}
            {@const isTargetMe = req.target_id === currentUserId}
            {@const userVote = req.votes?.find(v => v.voter_id === currentUserId)}
            {@const upCount = req.votes?.filter(v => v.vote_type === 'up').length || 0}
            {@const downCount = req.votes?.filter(v => v.vote_type === 'down').length || 0}
            {@const isUnmuted = unmutedVideoId === req.id}

            <article class="post-card">
              <div class="post-header">
                <div class="user-info">
                  {#if req.target.avatar_url}
                    <img src={req.target.avatar_url} alt={req.target.username} class="avatar-img" />
                  {:else}
                    <div class="avatar-placeholder">{req.target.username.charAt(0).toUpperCase()}</div>
                  {/if}
                  <div>
                    <span class="target-name">
                      {req.target.username}
                      {#if isTargetMe}
                        <span class="self-tag">(Toi)</span>
                      {/if}
                    </span>
                    <span class="creator-name">
                      {req.creator_id === currentUserId ? 'par toi-même' : `par @${req.creator?.username || 'anonyme'}`}
                    </span>
                  </div>
                </div>
                <div class="badge-time">
                  ⏱ {getTimeRemaining(req.expires_at)}
                </div>
              </div>

              <p class="post-desc">{req.description}</p>

              {#if req.media_url}
                <div 
                  class="post-media" 
                  role="button" 
                  tabindex="0"
                  onclick={() => modalMediaUrl = req.media_url}
                  onkeydown={(e) => e.key === 'Enter' && (modalMediaUrl = req.media_url)}
                >
                  {#if isVideo(req.media_url)}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video 
                      src={req.media_url} 
                      preload="metadata" 
                      autoplay 
                      loop 
                      muted={!isUnmuted} 
                      playsinline
                    ></video>
                    
                    <button class="sound-toggle-btn" onclick={(e) => toggleVideoSound(e, req.id)}>
                      {isUnmuted ? '🔊' : '🔇'}
                    </button>
                    <span class="media-badge">▶ Vidéo</span>
                  {:else}
                    <img src={req.media_url} alt="Preuve" loading="lazy" />
                  {/if}
                </div>
              {/if}

              <!-- Blocage du vote pour son propre dossier -->
              {#if isTargetMe}
                <div class="self-vote-notice">
                  Tu ne peux pas voter pour toi
                </div>
              {/if}

              <div class="vote-bar">
                <button 
                  class="vote-pill up {userVote?.vote_type === 'up' ? 'active-up' : ''}" 
                  disabled={isTargetMe}
                  onclick={() => handleVote(req.id, 'up')}
                >
                  <span class="vote-icon">📈</span>
                  <span class="vote-label">+ Aura</span>
                  <span class="vote-count">{upCount}</span>
                </button>

                <button 
                  class="vote-pill down {userVote?.vote_type === 'down' ? 'active-down' : ''}" 
                  disabled={isTargetMe}
                  onclick={() => handleVote(req.id, 'down')}
                >
                  <span class="vote-icon">📉</span>
                  <span class="vote-label">- Aura</span>
                  <span class="vote-count">{downCount}</span>
                </button>
              </div>
            </article>
          {/each}
        </div>
      {/if}

    <!-- 2. CRÉATION D'UNE DEMANDE -->
    {:else if currentTab === 'create'}
      <div class="view-container">
        <h2>Nouvelle demande</h2>
        <p class="view-sub">Envoie la masterclass stp</p>

        {#if createError}
          <div class="banner error">{createError}</div>
        {/if}

        <form onsubmit={handleCreateRequest} class="app-form">
          <div class="input-group">
            <label for="target-select">Qui est la cible ?</label>
            <select id="target-select" bind:value={selectedTargetId} required>
              <option value="" disabled selected>Sélectionne un membre</option>
              {#each targetUsers as user}
                <option value={user.id}>
                  {user.username} {user.id === currentUserId ? '(Moi)' : ''}
                </option>
              {/each}
            </select>
          </div>

          <div class="input-group">
            <label for="motif-text">Le motif</label>
            <textarea 
              id="motif-text"
              bind:value={description} 
              placeholder="Explique ce qui s'est passé..." 
              rows="4" 
              required
            ></textarea>
          </div>

          <div class="input-group">
            <label for="media-file">Preuve visuelle (photo / vidéo max 30s)</label>
            <input 
              id="media-file"
              type="file" 
              accept="image/*,video/*" 
              onchange={(e) => {
                const target = e.target as HTMLInputElement;
                if (target.files) fileToUpload = target.files[0];
              }} 
            />
          </div>

          <button type="submit" class="submit-btn" disabled={isSubmitting}>
            {isSubmitting ? 'Envoi rapide...' : 'Lancer le vote (2h)'}
          </button>
        </form>
      </div>

    <!-- 3. CLASSEMENTS -->
    {:else if currentTab === 'leaderboard'}
      <div class="view-container">
        <!-- 3 Catégories Principales -->
        <div class="segmented-control">
          <button 
            class="segment {mainLeaderboard === 'coloc' ? 'active' : ''}" 
            onclick={() => mainLeaderboard = 'coloc'}
          >
            🏠 Coloc
          </button>
          <button 
            class="segment {mainLeaderboard === 'all' ? 'active' : ''}" 
            onclick={() => mainLeaderboard = 'all'}
          >
            🌍 Tout le monde
          </button>
          <button 
            class="segment {mainLeaderboard === 'monthly' ? 'active' : ''}" 
            onclick={() => mainLeaderboard = 'monthly'}
          >
            🏆 Ce mois-ci
          </button>
        </div>

        <!-- Sous-onglets Mois / All-Time centrés -->
        {#if mainLeaderboard !== 'monthly'}
          <div class="sub-segmented-control">
            <button 
              class="sub-segment {subLeaderboardTime === 'month' ? 'active' : ''}" 
              onclick={() => subLeaderboardTime = 'month'}
            >
              📅 Ce Mois
            </button>
            <button 
              class="sub-segment {subLeaderboardTime === 'alltime' ? 'active' : ''}" 
              onclick={() => subLeaderboardTime = 'alltime'}
            >
              👑 All-Time
            </button>
          </div>
        {/if}

        {#if mainLeaderboard === 'monthly'}
          <!-- Vue Ce mois-ci : Top 3 & Flop 3 -->
          <div class="monthly-awards">
            <section class="award-block">
              <h3 class="award-title gold">👑 Les Masterclass (+ Aura)</h3>
              {#if top3Requests.length === 0}
                <p class="empty-hall">Aucun exploit positif ce mois-ci.</p>
              {:else}
                <div class="hall-list">
                  {#each top3Requests as req, i}
                    <div class="hall-item positive">
                      <div class="hall-item-header">
                        <div class="hall-user-meta">
                          <span class="hall-rank">#{i + 1}</span>
                          <strong>{req.target.username}</strong>
                        </div>
                        <span class="hall-score">+{req.delta} pts</span>
                      </div>

                      <p class="hall-desc">{req.description}</p>

                      {#if req.media_url}
                        <div 
                          class="hall-media-wrap" 
                          role="button" 
                          tabindex="0"
                          onclick={() => modalMediaUrl = req.media_url}
                          onkeydown={(e) => e.key === 'Enter' && (modalMediaUrl = req.media_url)}
                        >
                          {#if isVideo(req.media_url)}
                            <video src={req.media_url} preload="metadata" muted playsinline></video>
                            <span class="media-badge">▶ Vidéo</span>
                          {:else}
                            <img src={req.media_url} alt="Preuve masterclass" loading="lazy" />
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </section>

            <section class="award-block">
              <h3 class="award-title red">💀 Les Pires Hontes (- Aura)</h3>
              {#if flop3Requests.length === 0}
                <p class="empty-hall">Personne n'a pris de grosse honte ce mois-ci.</p>
              {:else}
                <div class="hall-list">
                  {#each flop3Requests as req, i}
                    <div class="hall-item negative">
                      <div class="hall-item-header">
                        <div class="hall-user-meta">
                          <span class="hall-rank">#{i + 1}</span>
                          <strong>{req.target.username}</strong>
                        </div>
                        <span class="hall-score loss">{req.delta} pts</span>
                      </div>

                      <p class="hall-desc">{req.description}</p>

                      {#if req.media_url}
                        <div 
                          class="hall-media-wrap" 
                          role="button" 
                          tabindex="0"
                          onclick={() => modalMediaUrl = req.media_url}
                          onkeydown={(e) => e.key === 'Enter' && (modalMediaUrl = req.media_url)}
                        >
                          {#if isVideo(req.media_url)}
                            <video src={req.media_url} preload="metadata" muted playsinline></video>
                            <span class="media-badge">▶ Vidéo</span>
                          {:else}
                            <img src={req.media_url} alt="Preuve honte" loading="lazy" />
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          </div>
        {:else}
          <!-- Vue Liste Classement -->
          <div class="rank-list">
            {#each displayedProfiles as profile, index}
              {@const currentScore = subLeaderboardTime === 'alltime' ? (profile.all_time_aura ?? 100) : profile.aura_score}
              <div class="rank-item {index === 0 ? 'first' : ''} {index === 1 ? 'second' : ''} {index === 2 ? 'third' : ''}">
                <div class="rank-number">
                  {#if index === 0}👑{:else}#{index + 1}{/if}
                </div>
                {#if profile.avatar_url}
                  <img src={profile.avatar_url} alt={profile.username} class="rank-avatar-img" />
                {:else}
                  <div class="rank-avatar">
                    {profile.username.charAt(0).toUpperCase()}
                  </div>
                {/if}
                <div class="rank-info">
                  <span class="rank-name">{profile.username}</span>
                  {#if profile.is_coloc}
                    <span class="pill-coloc">Coloc</span>
                  {/if}
                </div>
                <div class="rank-score" class:negative={currentScore < 100}>
                  {currentScore}
                  <span class="score-unit">pts</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    <!-- 4. PAGE PROFIL -->
    {:else if currentTab === 'profile'}
      <div class="view-container">
        <h2>Mon Profil</h2>
        <p class="view-sub">Gère ta photo, ton pseudo, tes notifications et tes stats.</p>

        <div class="profile-stats-card">
          <div class="stat-box">
            <span class="stat-label">Mois</span>
            <span class="stat-value" class:negative={(myProfile?.aura_score || 0) < 100}>
              {myProfile?.aura_score || 0}
            </span>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-box">
            <span class="stat-label">All-Time</span>
            <span class="stat-value" class:negative={(myProfile?.all_time_aura || 100) < 100}>
              {myProfile?.all_time_aura || 100}
            </span>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-box">
            <span class="stat-label">Rang</span>
            <span class="stat-value">#{myRank || '-'}</span>
          </div>
        </div>

        {#if profileMessage}
          <div class="banner {profileMessage.type}">
            {profileMessage.text}
          </div>
        {/if}

        <form onsubmit={handleUpdateProfile} class="app-form">
          <div class="avatar-edit-section">
            <div class="avatar-preview-wrap">
              {#if avatarPreview}
                <img src={avatarPreview} alt="Aperçu" class="large-avatar-img" />
              {:else}
                <div class="large-avatar-placeholder">
                  {newUsername ? newUsername.charAt(0).toUpperCase() : '👤'}
                </div>
              {/if}
              <label for="avatar-input" class="avatar-edit-badge">📷</label>
            </div>
            <input 
              id="avatar-input" 
              type="file" 
              accept="image/*" 
              onchange={handleAvatarSelect} 
              style="display: none;"
            />
            <span class="avatar-hint">Touche l'icône pour changer d'image</span>
          </div>

          <div class="input-group">
            <label for="profile-username">Pseudo</label>
            <input 
              id="profile-username"
              type="text" 
              bind:value={newUsername} 
              required
            />
          </div>

          <button type="submit" class="submit-btn" disabled={isUpdatingProfile}>
            {isUpdatingProfile ? 'Sauvegarde...' : 'Enregistrer les modifications'}
          </button>
        </form>

        <hr class="separator" />

        <!-- Bouton Notifications Push -->
        <button 
          type="button"
          class="push-btn {isPushSubscribed ? 'active' : ''}" 
          onclick={handleTogglePush}
          disabled={pushLoading}
        >
          <span>{isPushSubscribed ? '🔔 Notifications Push Activées' : '🔕 Activer les Notifications Push'}</span>
        </button>

        <button class="logout-btn" onclick={handleLogout}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          <span>Se déconnecter</span>
        </button>
      </div>
    {/if}
  </main>

  <!-- Bottom Navigation Bar -->
  <nav class="bottom-bar">
    <button 
      class="nav-tab {currentTab === 'feed' ? 'active' : ''}" 
      onclick={() => currentTab = 'feed'}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
      <span>Feed</span>
    </button>

    <button 
      class="nav-tab create-tab {currentTab === 'create' ? 'active' : ''}" 
      onclick={() => currentTab = 'create'}
    >
      <div class="plus-btn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </div>
    </button>

    <button 
      class="nav-tab {currentTab === 'leaderboard' ? 'active' : ''}" 
      onclick={() => currentTab = 'leaderboard'}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
      <span>Classement</span>
    </button>
  </nav>
</div>

<!-- Modal Plein Écran avec Enregistrement direct -->
{#if modalMediaUrl}
  <div 
    class="lightbox" 
    role="button" 
    tabindex="0"
    onclick={() => modalMediaUrl = null}
    onkeydown={(e) => e.key === 'Escape' && (modalMediaUrl = null)}
  >
    <div class="lightbox-body" onclick={(e) => e.stopPropagation()} role="presentation">
      {#if isVideo(modalMediaUrl)}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={modalMediaUrl} controls autoplay playsinline></video>
      {:else}
        <img src={modalMediaUrl} alt="Agrandissement" />
      {/if}

      <div class="lightbox-actions">
        <button class="lightbox-btn-download" onclick={downloadCurrentMedia} disabled={isDownloading}>
          {isDownloading ? '⏳ Enregistrement...' : '📥 Enregistrer dans la pellicule'}
        </button>
        <button class="lightbox-close" onclick={() => modalMediaUrl = null}>✕</button>
      </div>
    </div>
  </div>
{/if}

<style>
:global(*) {
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
  }
  :global(body) {
    margin: 0;
    background-color: #000000;
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    user-select: none;
    touch-action: pan-x pan-y;
  }

  .app-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    max-width: 480px;
    margin: 0 auto;
    background: #000;
    position: relative;
  }

  /* Top Bar */
  .top-bar {
      height: calc(54px + env(safe-area-inset-top));
      padding-top: env(safe-area-inset-top);
      padding-left: 16px;
      padding-right: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1f1f23;
      position: sticky;
      top: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      z-index: 10;
    }
  .logo {
    font-weight: 900;
    font-size: 1.1rem;
    letter-spacing: 1px;
    background: linear-gradient(90deg, #ec4899, #8b5cf6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .profile-header-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    border-radius: 50%;
  }
  .profile-header-btn.active {
    outline: 2px solid #8b5cf6;
  }
  .header-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }
  .header-avatar-placeholder {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #27272a;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: bold;
    color: #fff;
  }

  /* Main & Pull to refresh */
  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 12px 85px;
    position: relative;
  }
  .pull-indicator {
    position: absolute;
    top: 10px;
    left: 50%;
    width: 36px;
    height: 36px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    transition: transform 0.1s ease-out;
    pointer-events: none;
    margin-left: -18px;
  }
  .pull-arrow {
    color: #a855f7;
    font-size: 16px;
    font-weight: 900;
    transition: transform 0.1s linear;
  }
  .pull-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #27272a;
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .view-container { padding: 8px 4px; }
  .view-container h2 { margin: 0 0 4px; font-size: 1.3rem; }
  .view-sub { color: #71717a; font-size: 13px; margin: 0 0 18px; }

  /* Season Banner */
  .season-banner {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .season-badge {
    font-size: 12px;
    padding: 8px 12px;
    border-radius: 10px;
    font-weight: 600;
  }
  .season-badge.king {
    background: rgba(234, 179, 8, 0.12);
    border: 1px solid rgba(234, 179, 8, 0.35);
    color: #facc15;
  }
  .season-badge.trash {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171;
  }

  /* Feed */
  .feed-list { display: flex; flex-direction: column; gap: 16px; }
  .post-card {
    background: #121215;
    border: 1px solid #222228;
    border-radius: 16px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .post-header { display: flex; justify-content: space-between; align-items: center; }
  .user-info { display: flex; align-items: center; gap: 10px; }
  .avatar-img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
  .avatar-placeholder {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6366f1, #a855f7);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 14px;
  }
  .target-name { display: block; font-weight: 700; font-size: 15px; }
  .self-tag { color: #a855f7; font-size: 13px; font-weight: 800; }
  .creator-name { display: block; font-size: 12px; color: #71717a; }
  .badge-time {
    font-size: 11px;
    background: #1e1e24;
    padding: 4px 8px;
    border-radius: 100px;
    color: #a1a1aa;
    font-weight: 600;
  }
  .post-desc {
    margin: 0;
    font-size: 14px;
    line-height: 1.45;
    color: #e4e4e7;
    white-space: pre-wrap;
  }
  .post-media {
    position: relative;
    border-radius: 12px;
    overflow: hidden;
    background: #09090b;
    max-height: 320px;
    cursor: pointer;
  }
  .post-media img, .post-media video {
    width: 100%;
    max-height: 320px;
    object-fit: contain;
    display: block;
  }
  .sound-toggle-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.75);
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    cursor: pointer;
    z-index: 2;
  }
  .media-badge {
    position: absolute;
    bottom: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.7);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .self-vote-notice {
    font-size: 11px;
    font-weight: 600;
    color: #a1a1aa;
    text-align: center;
    background: #18181b;
    padding: 6px;
    border-radius: 8px;
    border: 1px dashed #27272a;
  }

  /* Votes */
  .vote-bar { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .vote-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    border-radius: 12px;
    border: 1px solid #27272a;
    background: #18181b;
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    transition: 0.15s ease;
  }
  .vote-pill:active:not(:disabled) { transform: scale(0.97); }
  .vote-pill:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .vote-count { background: #27272a; padding: 2px 6px; border-radius: 6px; font-size: 11px; }
  .vote-pill.active-up { background: rgba(34, 197, 94, 0.15); border-color: #22c55e; color: #4ade80; }
  .vote-pill.active-down { background: rgba(239, 68, 68, 0.15); border-color: #ef4444; color: #f87171; }

  /* App Forms */
  .app-form { display: flex; flex-direction: column; gap: 16px; }
  .input-group { display: flex; flex-direction: column; gap: 6px; }
  .input-group label { font-size: 13px; font-weight: 600; color: #a1a1aa; }
  .input-group select, .input-group textarea, .input-group input[type="text"], .input-group input[type="file"] {
    background: #121215;
    border: 1px solid #27272a;
    color: white;
    padding: 12px;
    border-radius: 10px;
    font-size: 14px;
    width: 100%;
  }
  .submit-btn {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    border: none;
    color: white;
    font-weight: 700;
    padding: 14px;
    border-radius: 12px;
    font-size: 15px;
    cursor: pointer;
    margin-top: 6px;
  }
  .submit-btn:disabled { opacity: 0.6; }
  .banner { padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
  .banner.error { background: #450a0a; color: #f87171; }
  .banner.success { background: #052e16; color: #4ade80; }

  /* Profil */
  .profile-stats-card {
    display: flex;
    background: #121215;
    border: 1px solid #27272a;
    border-radius: 14px;
    padding: 12px;
    margin-bottom: 20px;
    justify-content: space-around;
  }
  .stat-box { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .stat-label { font-size: 11px; color: #71717a; text-transform: uppercase; font-weight: 700; }
  .stat-value { font-size: 16px; font-weight: 800; color: #4ade80; }
  .stat-value.negative { color: #f87171; }
  .stat-divider { width: 1px; background: #27272a; }
  .avatar-edit-section { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-bottom: 8px; }
  .avatar-preview-wrap { position: relative; width: 84px; height: 84px; }
  .large-avatar-img { width: 84px; height: 84px; border-radius: 50%; object-fit: cover; border: 2px solid #8b5cf6; }
  .large-avatar-placeholder {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 900;
  }
  .avatar-edit-badge {
    position: absolute;
    bottom: 0;
    right: 0;
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    cursor: pointer;
  }
  .avatar-hint { font-size: 12px; color: #71717a; }
  .separator { border: none; border-top: 1px solid #1f1f23; margin: 24px 0 16px; }
  
  .push-btn {
    width: 100%;
    background: #18181b;
    border: 1px solid #27272a;
    color: #e4e4e7;
    padding: 12px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    margin-bottom: 10px;
  }
  .push-btn.active {
    border-color: #22c55e;
    color: #4ade80;
    background: rgba(34, 197, 94, 0.1);
  }

  .logout-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: #18181b;
    border: 1px solid #27272a;
    color: #ef4444;
    padding: 12px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  /* Leaderboard */
  .segmented-control {
    display: flex;
    background: #18181b;
    padding: 3px;
    border-radius: 10px;
    margin-bottom: 10px;
    gap: 2px;
  }
  .segment {
    flex: 1;
    background: none;
    border: none;
    color: #71717a;
    padding: 8px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .segment.active { background: #27272a; color: #fff; }

  /* Sous-onglets centrés */
  .sub-segmented-control {
    display: flex;
    background: #121215;
    border: 1px solid #1f1f23;
    padding: 2px;
    border-radius: 8px;
    margin: 0 auto 16px auto;
    gap: 2px;
    width: fit-content;
    min-width: 220px;
    justify-content: center;
  }
  .sub-segment {
    flex: 1;
    background: none;
    border: none;
    color: #71717a;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 700;
    border-radius: 6px;
    cursor: pointer;
    text-align: center;
  }
  .sub-segment.active {
    background: #27272a;
    color: #a855f7;
  }

  .rank-list { display: flex; flex-direction: column; gap: 8px; }
  .rank-item {
    display: flex;
    align-items: center;
    background: #121215;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid #1f1f23;
  }
  .rank-item.first {
    border-color: #eab308;
    background: linear-gradient(90deg, #18181b 0%, rgba(234, 179, 8, 0.08) 100%);
  }
  .rank-number { width: 30px; font-weight: 800; font-size: 14px; color: #71717a; }
  .first .rank-number { color: #eab308; font-size: 16px; }
  .rank-avatar-img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; margin-right: 12px; }
  .rank-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #27272a;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 12px;
    margin-right: 12px;
  }
  .rank-info { flex: 1; display: flex; align-items: center; gap: 6px; }
  .rank-name { font-weight: 600; font-size: 14px; }
  .pill-coloc {
    background: #312e81;
    color: #c7d2fe;
    font-size: 10px;
    padding: 2px 5px;
    border-radius: 4px;
    font-weight: 700;
  }
  .rank-score { font-weight: 800; font-size: 15px; color: #4ade80; }
  .rank-score.negative { color: #f87171; }
  .score-unit { font-size: 10px; font-weight: 400; color: #71717a; margin-left: 2px; }

  /* Monthly Awards Styles */
  .monthly-awards { display: flex; flex-direction: column; gap: 24px; }
  .award-block { display: flex; flex-direction: column; gap: 10px; }
  .award-title { font-size: 14px; font-weight: 800; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; }
  .award-title.gold { color: #facc15; }
  .award-title.red { color: #f87171; }
  .empty-hall { font-size: 13px; color: #71717a; margin: 4px 0; }
  .hall-list { display: flex; flex-direction: column; gap: 12px; }
  .hall-item {
    display: flex;
    flex-direction: column;
    background: #121215;
    border: 1px solid #222228;
    border-radius: 14px;
    padding: 12px;
    gap: 8px;
  }
  .hall-item.positive { border-left: 4px solid #22c55e; }
  .hall-item.negative { border-left: 4px solid #ef4444; }
  .hall-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hall-user-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .hall-rank { font-weight: 900; font-size: 15px; color: #a1a1aa; }
  .hall-score { font-weight: 800; color: #4ade80; font-size: 14px; }
  .hall-score.loss { color: #f87171; }
  .hall-desc { font-size: 13px; color: #e4e4e7; margin: 0; line-height: 1.4; }
  .hall-media-wrap {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    background: #09090b;
    max-height: 220px;
    cursor: pointer;
    margin-top: 4px;
  }
  .hall-media-wrap img, .hall-media-wrap video {
    width: 100%;
    max-height: 220px;
    object-fit: contain;
    display: block;
  }

  /* Bottom Bar */
  .bottom-bar {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 100%;
      max-width: 480px;
      height: calc(64px + env(safe-area-inset-bottom));
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: 16px;
      padding-right: 16px;
      background: rgba(10, 10, 12, 0.92);
      backdrop-filter: blur(16px);
      border-top: 1px solid #1f1f23;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      z-index: 20;
    }
  .nav-tab {
      background: none;
      border: none;
      color: #71717a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }

    .nav-tab.active {
      color: #ffffff;
    }

    .nav-tab.create-tab {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
    }
  .plus-btn {
      width: 46px;
      height: 34px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
      transition: transform 0.1s ease;
    }
    .plus-btn:active {
    transform: scale(0.92);
  }

  /* Lightbox */
  .lightbox {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.95);
    z-index: 999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .lightbox-body {
    position: relative;
    max-width: 95vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .lightbox-body img, .lightbox-body video {
    max-width: 100%;
    max-height: 70vh;
    border-radius: 12px;
    object-fit: contain;
  }
  .lightbox-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .lightbox-btn-download {
    background: #27272a;
    border: 1px solid #3f3f46;
    color: white;
    padding: 10px 18px;
    border-radius: 100px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .lightbox-close {
    background: #27272a;
    border: 1px solid #3f3f46;
    color: white;
    font-size: 18px;
    border-radius: 50%;
    width: 38px;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  /* States */
  .center-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60vh;
    text-align: center;
  }
  .empty-title { font-weight: 700; font-size: 16px; margin-bottom: 4px; }
  .empty-sub { font-size: 13px; color: #71717a; margin-bottom: 16px; }
  .btn-action-feed {
    background: #27272a;
    border: 1px solid #3f3f46;
    color: white;
    padding: 10px 16px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  .vote-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    border-radius: 12px;
    border: 1px solid #27272a;
    background: #18181b;
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    transition: transform 0.1s ease, background 0.15s ease, border-color 0.15s ease;
  }
  .vote-pill:active:not(:disabled) {
    transform: scale(0.92);
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid #27272a;
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>