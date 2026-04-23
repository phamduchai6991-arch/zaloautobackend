function collectIdentifiers(...values) {
  const identifiers = new Set();
  values.forEach((value) => {
    const text = String(value || '').trim();
    if (text) identifiers.add(text);
  });
  return identifiers;
}

export function isGroupJob(job) {
  if (job?.isGroup === true) return true;
  if (job?.isGroup === false) return false;
  const tab = String(job?.sourceTab || '').toLowerCase();
  return tab.includes('nhóm') || tab.includes('nhom') || tab === 'group' || tab === 'groups';
}

export function normalizeThreadId(value, isGroup) {
  const text = String(value || '').trim();
  if (!text || text === '—') return text;
  if (isGroup && (text.startsWith('g') || text.startsWith('G'))) {
    return text.slice(1);
  }
  return text;
}

export function getDelayMs(delayWindow) {
  const match = String(delayWindow || '').match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return 0;

  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 0;

  const min = Math.min(first, second);
  const max = Math.max(first, second);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function normalizeMemberVersionKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.split('_').length > 1) return text;
  return `${text}_0`;
}

function buildFriendIdentifierSet(friends) {
  const identifiers = new Set();
  (Array.isArray(friends) ? friends : []).forEach((friend) => {
    collectIdentifiers(friend?.userId, friend?.username, friend?.globalId).forEach((value) => identifiers.add(value));
  });
  return identifiers;
}

function buildGroupMemberRole(group, memberProfile, memberUserId) {
  const normalizedUserId = String(memberUserId || '').trim();
  if (!normalizedUserId) return 'Thành viên';

  if (String(group?.creatorId || '').trim() === normalizedUserId) {
    return 'Trưởng nhóm';
  }

  if (Number(memberProfile?.isAdmin) === 1 || Number(memberProfile?.is_admin) === 1) {
    return 'Phó nhóm';
  }

  return 'Thành viên';
}

function buildRelationLabel(relation) {
  if (Number(relation?.is_friend) === 1) return 'Bạn bè';
  if (Number(relation?.is_requested) === 1) return 'Đã gửi lời mời cho bạn';
  if (Number(relation?.is_requesting) === 1) return 'Bạn đã gửi lời mời';
  return 'Chưa kết bạn';
}

export function extractGroupMemberIds(group) {
  const ids = new Set();

  const pushId = (value) => {
    const text = String(value || '').trim();
    if (text) ids.add(text);
  };

  if (Array.isArray(group?.memberIds)) {
    group.memberIds.forEach((item) => pushId(item));
  }

  if (Array.isArray(group?.currentMems)) {
    group.currentMems.forEach((item) => {
      if (typeof item === 'object' && item !== null) {
        pushId(item.id || item.userId || item.uid);
      } else {
        pushId(item);
      }
    });
  }

  if (Array.isArray(group?.updateMems)) {
    group.updateMems.forEach((item) => {
      if (typeof item === 'object' && item !== null) {
        pushId(item.id || item.userId || item.uid);
      } else {
        pushId(item);
      }
    });
  }

  if (Array.isArray(group?.memVerList)) {
    group.memVerList.forEach((item) => pushId(item));
  }

  return Array.from(ids);
}

export function summarizeGroupMap(groupInfo, hiddenGroupIds = new Set()) {
  const map = groupInfo?.gridInfoMap || {};
  return Object.values(map).map((group) => ({
    userId: group.groupId || '',
    displayName: group.name || '',
    avatar: group.avt || group.fullAvt || '',
    totalMember: group.totalMember || 0,
    memberIds: extractGroupMemberIds(group),
    creatorId: group.creatorId || '',
    desc: group.desc || '',
    globalId: group.globalId || '',
    type: group.type,
    subType: group.subType,
    updatedTime: group.updatedTime || group.actionTime || group.lastMsgTime || group.lastActionTime || 0,
    actionTime: group.actionTime || group.updatedTime || 0,
    lastMsgTime: group.lastMsgTime || group.updatedTime || group.actionTime || 0,
    lastMessage: group.lastMessage || group.lastMsg || group.lastContent || group.desc || '',
    isHiddenConversation: hiddenGroupIds.has(String(group.groupId || '').trim()),
  }));
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function safeApiCall(callback, fallbackValue) {
  try {
    return await callback();
  } catch (_) {
    return fallbackValue;
  }
}

export function normalizeSentFriendRequests(requestsMap) {
  return Object.values(requestsMap || {}).map((item) => ({
    userId: item.userId || '',
    displayName: item.displayName || item.zaloName || 'Không rõ tên',
    zaloName: item.zaloName || '',
    avatar: item.avatar || '',
    globalId: item.globalId || '',
    message: item.fReqInfo?.message || '',
    requestedAt: item.fReqInfo?.time || 0,
    source: item.fReqInfo?.src || 0,
  }));
}

export function normalizeReceivedFriendRequests(response) {
  return Array.isArray(response?.recommItems)
    ? response.recommItems.map((item) => ({
        userId: item.dataInfo?.userId || '',
        displayName: item.dataInfo?.displayName || item.dataInfo?.zaloName || 'Không rõ tên',
        zaloName: item.dataInfo?.zaloName || '',
        avatar: item.dataInfo?.avatar || '',
        phoneNumber: item.dataInfo?.phoneNumber || '',
        status: item.dataInfo?.status || '',
        recommTime: item.dataInfo?.recommTime || 0,
        recommType: item.dataInfo?.recommType,
        isSeenFriendReq: Boolean(item.dataInfo?.isSeenFriendReq),
        message: item.dataInfo?.recommInfo?.message || '',
      }))
    : [];
}

export async function resolveGroupMembersOnly(api, groups, accountUserId) {
  const groupIds = groups
    .map((group) => normalizeThreadId(group?.groupId || group?.zid, true))
    .filter(Boolean);

  if (!groupIds.length) {
    return { membersByGroup: {} };
  }

  const groupInfo = await api.getGroupInfo(groupIds);
  const selfId = String(accountUserId || '').trim();
  const membersByGroup = {};

  for (const groupId of groupIds) {
    const group = groupInfo?.gridInfoMap?.[groupId];
    if (!group) {
      console.log('[members] group not found in gridInfoMap:', groupId);
      continue;
    }

    const adminIdSet = new Set(
      (Array.isArray(group.adminIds) ? group.adminIds : []).map((id) => String(id).trim()).filter(Boolean),
    );
    const creatorId = String(group.creatorId || '').trim();

    const memberVersionKeys = extractGroupMemberIds(group)
      .map((memberId) => normalizeMemberVersionKey(memberId))
      .filter(Boolean);

    console.log('[members] group:', groupId, 'name:', group?.name, 'memberKeys:', memberVersionKeys.length);

    if (!memberVersionKeys.length) {
      membersByGroup[groupId] = [];
      continue;
    }

    const currentMemsMap = {};
    if (Array.isArray(group.currentMems)) {
      group.currentMems.forEach((mem) => {
        const id = String(mem?.id || '').trim();
        if (id) currentMemsMap[id] = mem;
        const versionedId = `${id}_0`;
        if (id) currentMemsMap[versionedId] = mem;
      });
    }
    console.log('[members] currentMems:', (group.currentMems || []).length);

    const profileChunks = chunk(memberVersionKeys, 200);
    const groupProfileMap = {};
    const userInfoMap = {};

    for (const ids of profileChunks) {
      if (!ids.length) continue;

      const [groupMembersResponse, userInfoResponse] = await Promise.all([
        safeApiCall(
          () => withTimeout(api.getGroupMembersInfo(ids), 15000, 'Lấy thành viên nhóm quá chậm.'),
          { profiles: {} },
        ),
        safeApiCall(
          () => withTimeout(api.getUserInfo(ids), 15000, 'Lấy hồ sơ thành viên quá chậm.'),
          { changed_profiles: {} },
        ),
      ]);

      const gmProfiles = groupMembersResponse?.profiles || {};
      const uiProfiles = userInfoResponse?.changed_profiles || {};
      console.log('[members] getGroupMembersInfo:', Object.keys(gmProfiles).length,
        'getUserInfo:', Object.keys(uiProfiles).length);

      // Index profiles by BOTH plain and versioned keys (API may return either format)
      for (const [key, profile] of Object.entries(gmProfiles)) {
        groupProfileMap[key] = profile;
        const plain = key.replace(/_\d+$/, '');
        if (plain !== key) groupProfileMap[plain] = profile;
        else groupProfileMap[`${key}_0`] = profile;
      }
      for (const [key, profile] of Object.entries(uiProfiles)) {
        userInfoMap[key] = profile;
        const plain = key.replace(/_\d+$/, '');
        if (plain !== key) userInfoMap[plain] = profile;
        else userInfoMap[`${key}_0`] = profile;
      }
    }

    membersByGroup[groupId] = memberVersionKeys.map((memberKey) => {
      const plainKey = memberKey.replace(/_\d+$/, '');
      const uiProfile = userInfoMap[memberKey] || userInfoMap[plainKey] || {};
      const gmProfile = groupProfileMap[memberKey] || groupProfileMap[plainKey] || {};
      const actualUserId = String(
        uiProfile?.userId || uiProfile?.id || gmProfile?.userId || gmProfile?.id || plainKey,
      ).trim();

      if (!actualUserId || actualUserId === selfId) return null;

      const currentMem = currentMemsMap[actualUserId] || currentMemsMap[memberKey] || currentMemsMap[plainKey] || {};
      const displayName = uiProfile.displayName || uiProfile.zaloName
        || gmProfile.displayName || gmProfile.zaloName
        || currentMem.dName || currentMem.zaloName || '';
      const avatar = uiProfile.avatar || gmProfile.avatar || currentMem.avatar || currentMem.avatar_25 || '';

      let role = 'Thành viên';
      if (creatorId && creatorId === actualUserId) {
        role = 'Trưởng nhóm';
      } else if (adminIdSet.has(actualUserId) || Number(gmProfile?.isAdmin) === 1) {
        role = 'Phó nhóm';
      }

      const isFriend = Number(uiProfile?.isFr) === 1;

      return {
        key: `${groupId}_${actualUserId}`,
        zid: actualUserId,
        name: displayName || 'Thành viên',
        avatar,
        phone: '—',
        role,
        relationLabel: isFriend ? 'Bạn bè' : 'Chưa kết bạn',
        isFriend,
        sourceTab: group?.name || 'Nhóm',
        groupId,
      };
    }).filter(Boolean);

    console.log('[members] result:', membersByGroup[groupId].length,
      'with names:', membersByGroup[groupId].filter((m) => m.name !== 'Thành viên').length);
  }

  return { membersByGroup };
}

export async function resolveInviteTargetsFromGroups(api, groups, accountUserId, options = {}) {
  const groupIds = groups
    .map((group) => normalizeThreadId(group?.groupId || group?.zid, true))
    .filter(Boolean);

  if (!groupIds.length) {
    return [];
  }

  const [friendsResponse, groupInfo] = await Promise.all([
    safeApiCall(() => api.getAllFriends(), []),
    api.getGroupInfo(groupIds),
  ]);

  const existingFriendIds = buildFriendIdentifierSet(friendsResponse);
  const selfId = String(accountUserId || '').trim();
  const targets = [];
  const groupSummaries = [];

  for (const groupId of groupIds) {
    const group = groupInfo?.gridInfoMap?.[groupId];
    const memberVersionKeys = extractGroupMemberIds(group).map((memberId) => normalizeMemberVersionKey(memberId));
    const relevantMemberKeys = memberVersionKeys.filter(Boolean);

    if (!relevantMemberKeys.length) {
      groupSummaries.push({
        groupId,
        groupName: group?.name || 'Nhóm',
        totalMembers: 0,
        friendCount: 0,
        incomingRequestCount: 0,
        outgoingRequestCount: 0,
        inviteableCount: 0,
      });
      continue;
    }

    const profileChunks = chunk(relevantMemberKeys, 200);
    const groupProfileMap = {};
    const userInfoMap = {};

    for (const ids of profileChunks) {
      if (!ids.length) continue;
      const groupMembersResponse = await safeApiCall(
        () => withTimeout(api.getGroupMembersInfo(ids), 15000, 'Lấy thành viên nhóm quá chậm.'),
        { profiles: {} },
      );
      for (const [key, profile] of Object.entries(groupMembersResponse?.profiles || {})) {
        groupProfileMap[key] = profile;
        const plain = key.replace(/_\d+$/, '');
        if (plain !== key) groupProfileMap[plain] = profile;
        else groupProfileMap[`${key}_0`] = profile;
      }

      const userInfoResponse = await safeApiCall(
        () => withTimeout(api.getUserInfo(ids), 15000, 'Lấy hồ sơ thành viên quá chậm.'),
        { changed_profiles: {} },
      );
      for (const [key, profile] of Object.entries(userInfoResponse?.changed_profiles || {})) {
        userInfoMap[key] = profile;
        const plain = key.replace(/_\d+$/, '');
        if (plain !== key) userInfoMap[plain] = profile;
        else userInfoMap[`${key}_0`] = profile;
      }
    }

    const relationStatuses = new Map();
    for (const memberKey of relevantMemberKeys) {
      const plainKey = memberKey.replace(/_\d+$/, '');
      const profile = userInfoMap[memberKey] || userInfoMap[plainKey] || groupProfileMap[memberKey] || groupProfileMap[plainKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || plainKey).trim();

      if (!actualUserId || actualUserId === selfId) {
        continue;
      }

      const profileIdentifiers = collectIdentifiers(
        memberKey,
        actualUserId,
        profile?.id,
        profile?.userId,
        profile?.globalId,
        profile?.username,
      );

      const alreadyFriend = Number(profile?.isFr) === 1
        || Array.from(profileIdentifiers).some((identifier) => existingFriendIds.has(identifier));
      if (alreadyFriend) {
        relationStatuses.set(memberKey, {
          is_friend: 1,
          is_requested: 0,
          is_requesting: 0,
        });
        continue;
      }

      const status = await safeApiCall(
        () => withTimeout(api.getFriendRequestStatus(actualUserId), 8000, 'Kiểm tra trạng thái bạn bè quá chậm.'),
        {
          is_friend: 0,
          is_requested: 0,
          is_requesting: 0,
        },
      );
      relationStatuses.set(memberKey, status || {
        is_friend: 0,
        is_requested: 0,
        is_requesting: 0,
      });
    }

    const candidateKeys = relevantMemberKeys.filter((memberKey) => {
      const plainKey = memberKey.replace(/_\d+$/, '');
      const profile = userInfoMap[memberKey] || userInfoMap[plainKey] || groupProfileMap[memberKey] || groupProfileMap[plainKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || plainKey).trim();
      if (!actualUserId || actualUserId === selfId) return false;

      const relation = relationStatuses.get(memberKey) || {};
      return Number(relation.is_friend) !== 1
        && Number(relation.is_requested) !== 1
        && Number(relation.is_requesting) !== 1;
    });

    let friendCount = 0;
    let incomingRequestCount = 0;
    let outgoingRequestCount = 0;
    relationStatuses.forEach((relation) => {
      if (Number(relation?.is_friend) === 1) {
        friendCount += 1;
      } else if (Number(relation?.is_requested) === 1) {
        incomingRequestCount += 1;
      } else if (Number(relation?.is_requesting) === 1) {
        outgoingRequestCount += 1;
      }
    });

    groupSummaries.push({
      groupId,
      groupName: group?.name || 'Nhóm',
      totalMembers: relationStatuses.size,
      friendCount,
      incomingRequestCount,
      outgoingRequestCount,
      inviteableCount: candidateKeys.length,
    });

    if (!candidateKeys.length) {
      continue;
    }

    candidateKeys.forEach((memberKey) => {
      const plainKey = memberKey.replace(/_\d+$/, '');
      const profile = userInfoMap[memberKey] || userInfoMap[plainKey] || groupProfileMap[memberKey] || groupProfileMap[plainKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || plainKey).trim();
      if (!actualUserId) return;

      targets.push({
        key: `${groupId}_${actualUserId}`,
        zid: actualUserId,
        name: profile.displayName || profile.zaloName || `Thành viên ${group?.name || 'nhóm'}`,
        avatar: profile.avatar || '',
        phone: '—',
        sourceTab: group?.name || 'Nhóm',
        groupId,
      });
    });
  }

  return {
    targets,
    summaries: groupSummaries,
    totals: groupSummaries.reduce((accumulator, summary) => ({
      totalMembers: accumulator.totalMembers + Number(summary.totalMembers || 0),
      friendCount: accumulator.friendCount + Number(summary.friendCount || 0),
      incomingRequestCount: accumulator.incomingRequestCount + Number(summary.incomingRequestCount || 0),
      outgoingRequestCount: accumulator.outgoingRequestCount + Number(summary.outgoingRequestCount || 0),
      inviteableCount: accumulator.inviteableCount + Number(summary.inviteableCount || 0),
    }), {
      totalMembers: 0,
      friendCount: 0,
      incomingRequestCount: 0,
      outgoingRequestCount: 0,
      inviteableCount: 0,
    }),
  };
}