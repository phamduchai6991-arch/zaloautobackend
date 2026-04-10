# Zalo Web API Reference (Reverse-Engineered)

> Generated from Zalo Web (`chat.zalo.me`) webpack modules `dThN` (business logic) and `fBUP` (HTTP transport).

## Architecture

```
┌─────────────────────────────────────────────────┐
│  dThN.default  (Business Logic - API Service)    │
│  - Storage updates, E2EE handling, retry logic   │
│  - Calls r.default.xxx() = fBUP.default.xxx()    │
├─────────────────────────────────────────────────┤
│  fBUP.default  (HTTP Transport)                  │
│  - URL construction, AES encryption              │
│  - _get(), _post(), _postSendMsg() → _request()  │
├─────────────────────────────────────────────────┤
│  axios/XHR  (Physical Transport)                 │
│  - HTTP GET/POST with cookies                    │
│  - WebSocket for real-time (wss://ws3-msg...)    │
└─────────────────────────────────────────────────┘
```

## Common Parameters

All API calls include:
- **Query params**: `zpw_ver=681&zpw_type=30`
- **Encrypted body/params**: `params=encodeURIComponent(encodeAES(JSON.stringify(data)))`
- **Device ID**: `imei: getZaloClientID()` (in most requests)
- **Group IDs**: Prefixed with `"g"` in conversation IDs, stripped before API calls

## Base Transport Methods

```javascript
// _getCommonParams() → "zpw_ver=681&zpw_type=30"
_getCommonParams() { return this._constructUrlParams(ie); }

// _encodeParams(obj) → AES encrypted URL-encoded string
_encodeParams(e) {
  e = e instanceof Object ? JSON.stringify(e) : String(e);
  return encodeURIComponent(i.default.encodeAES(e));
}

// _get(url, queryParamsObj, commandId, subCmdId=0, timeout=10000, retry=0, ...)
_get(e, t, n, s=0, i=1e4, o=0, r, l={}, c=null) {
  t && (e += "?" + this._constructUrlParams(t));
  let d = { timeout: i, ...l };
  o > 0 && (d.retry = o);
  return this._request(true, e, null, d, n, s, false, c);
}

// _post(url, body, options, commandId, subCmdId, isRetryable=false, reqId=null)
_post(e, t, n, a, s, i=false, o=null) {
  let r = { timeout: 1e4, withCredentials: true, headers: {"Content-Type": "application/x-www-form-urlencoded"} };
  n = n ? Object.assign(r, n) : r;
  return this._request(false, e, t, n, a, s, i, o);
}

// _postSendMsg(urlConfig, body, retryOpts, commandId, subCmdId, clientId, reqId)
// urlConfig = { domainType, path, query } OR url string
_postSendMsg(e, t, n, a, s, i, o) {
  n.id = i; // clientId for tracking
  return this._post(e, t, n, a, s, true, o);
}

// _request(isGet, urlOrConfig, body, options, commandId, subCmdId, isRetry, reqId)
// When urlOrConfig is object: { domainType, path, query }
//   → resolves domain via p.b.getDomainByType(domainType) + path + "?" + query
```

---

## Domain Types

Accessed via `p.b.getXxxDomain()`:

| Getter | Purpose |
|--------|---------|
| `getChatDomain()` | 1:1 messages, typing, seen, keepalive |
| `getGroupDomain()` | Group messages, settings, members |
| `getFileDomain()` | File upload, photos, voice, cross-device |
| `getProfileDomain()` | User profiles, friends, online status |
| `getFriendDomain()` | Friend requests, block, phonebook |
| `getStickerDomain()` | Sticker search, categories |
| `getConversationDomain()` | Pinned, hidden, auto-delete conversations |
| `getAliasDomain()` | Friend aliases |
| `getLabelDomain()` | Conversation labels, archived chats |
| `getReactionDomain()` | Message reactions |
| `getGroupBoardDomain()` | Board topics, pins, reminders |
| `getGroupPollDomain()` | Polls |
| `getVoiceCallDomain()` | Voice/video calls |
| `getE2eeDomain()` | E2EE 1:1 messages |
| `getE2eeGroupDomain()` | E2EE group messages |
| `getGroupCloudDomain()` | Cloud message sync |
| `getMediaCloudDomain()` | Media cloud storage |
| `getAutoReplyDomain()` | Auto-reply |
| `getQuickMessageDomain()` | Quick reply templates |
| `getRecentSearchDomain()` | Recent search history |
| `getZInstantDomain()` | Z-Instant actions |
| `getZInstantMsgDomain()` | Bank transfers |
| `getBoardDomain()` | Personal todos |
| `getCatalogDomain()` | Product catalog |
| `getFriendLanDomain()` | LAN friend discovery |
| `getFallbackLpDomain()` | Fallback long-polling |
| `getConsentDomain()` | Surveys |
| `getDomainAuthenExtra()` | Linked devices |

---

## Message APIs

### Send Text Message (sendZText)
```
fBUP: sendZText(toId, message, isGroup, clientId, retryOpts, extraParams, reqId)

1:1:    POST /api/message/sms     → domainType: CHAT,  cmdId: 11151
Group:  POST /api/group/sendmsg   → domainType: GROUP, cmdId: 11163

Body: {
  message: "text",
  clientId: "unique-id",
  imei: getZaloClientID(),
  toid: "userId"           // 1:1
  // OR
  grid: "groupId",         // group (stripped "g" prefix)
  visibility: getVisibility(convId)  // group
}
```

### Send Quote/Reply Message
```
fBUP: sendQuoteMessage(toId, message, clientId, quotedMsg, retry, reqId)
fBUP: sendGroupQuoteMessage(groupId, message, clientId, mentions, quotedMsg, retry, reqId, extraParams)

1:1:    POST /api/message/quote  cmdId: 11771
Group:  POST /api/group/quote    cmdId: 11197

Body: {
  toid/grid, message, clientId, qmsgOwner, qmsgId, qmsgCliId, qmsgType, qmsgTs, qmsg, imei
}
```

### Send Link Message
```
fBUP: sendLinkMessage(toId, clientId, msg, href, src, title, desc, thumb, type, media, isGroup, mentions, retry, extraParams, reqId)

1:1:    POST /api/message/link    cmdId: 11286
Group:  POST /api/group/sendlink  cmdId: 11193
```

### Send Mention Message (Group only)
```
fBUP: sendMentionMessage(groupId, message, clientId, mentionInfo, retry, reqId, extraParams)

POST /api/group/mention  cmdId: 11198
Body: { grid, message, clientId, mentionInfo: JSON, language, visibility }
```

### Forward Message
```
fBUP: forwardMessage(toId, msgType, msgInfo, clientId, retry, reqId, extraParams)

1:1:    POST /api/message/forward  cmdId: 11199
Group:  POST /api/group/forward    cmdId: 11818
```

### Forward to Multiple
```
fBUP: forwardMultiMessage(toIds, msgType, msgInfo, isGroup, retry, extraParams)

1:1:    POST /api/message/mforward  cmdId: 12440
Group:  POST /api/group/mforward    cmdId: 12442
```

### Send Sticker
```
fBUP: sendSticker(toId, stickerId, cateId, type, isGroup, clientId, retry, extraParams, reqId)

1:1:    POST /api/message/sticker  cmdId: 11154
Group:  POST /api/group/sticker    cmdId: 11165
Body: { stickerId, cateId, type, clientId, imei, toid/grid }
```

### Send Photo
```
fBUP: _sendPhoto(toId, photoData, isGroup, clientId, mentions, retry, extraParams)

1:1:    POST /api/message/photo  cmdId: 11152 (FormData with fileContent)
Group:  POST /api/group/sendpt   cmdId: 11164
```

### Send Photo by URL
```
fBUP: sendPhotoByUrl(photoInfo, isGroup, clientId, ?, extraParams, ?)

1:1:    POST /api/message/photo_url  cmdId: 11775
Group:  POST /api/group/photo_url    cmdId: 11830
```

### Send Photo Async (Original quality)
```
fBUP: sendMsgPhotoAsync(photoData, isGroup, retry, reqId)

1:1:    POST /api/message/photo_original/send  cmdId: 11773
Group:  POST /api/group/photo_original/send    cmdId: 11826
```

### Send File
```
fBUP: sendFile(toId, fileContent, isGroup, clientId)

1:1:    POST /api/message/sharefile_full  cmdId: 11146 (FormData)
Group:  POST /api/group/sharefile_full    cmdId: 11191
```

### Send File Async
```
fBUP: sendMsgFileAsync(fileData, isGroup, retry, reqId)

1:1:    POST /api/message/asyncfile/msg  cmdId: 11777
Group:  POST /api/group/asyncfile/msg    cmdId: 13001
```

### Send Voice
```
fBUP: sendVoice(toId, voiceBlob, isGroup, clientId)

1:1:    POST /api/message/voicemp3  cmdId: 11148 (FormData)
Group:  POST /api/group/sendmp3     cmdId: 11169
```

### Send GIF
```
fBUP: sendGif(toId, clientId, thumb, width, height, msg, type, ?, href, ?, retryOpt, src, reqId, extra)

1:1:    POST /api/message/gif  cmdId: 11292
Group:  POST /api/group/gif    cmdId: 11194
```

### Send Contact
```
fBUP: forwardContactOA(toId, contactInfo, clientId, retry, reqId, extraParams)

1:1:    POST /api/message/contact  cmdId: 11774
Group:  POST /api/group/contact    cmdId: 11827
```

### Send Typing Indicator
```
fBUP: sendIsTyping(toId, isPage)

1:1:    POST /api/message/typing  cmdId: 11144
Group:  POST /api/group/typing    cmdId: 11196
Body: { toid/grid, destType, imei }
```

### Send Reaction
```
fBUP: sendReactionMessage(toId, reactList, isGroup)

1:1:    POST /api/message/reaction  cmdId: 12410
Group:  POST /api/group/reaction    cmdId: 12411
Body: { toid/grid, react_list, imei }
```

### Undo/Recall Message
```
fBUP: undoMessage(msgId, convId, clientId, cliMsgIdUndo)

1:1:    POST /api/message/undo    cmdId: 11281
Group:  POST /api/group/undomsg   cmdId: 11192
Body: { msgId, toid/grid, clientId, cliMsgIdUndo, imei, visibility }
```

### Delete Message
```
fBUP: deleteOneOneMessageV2(toId, cliMsgId, msgs, onlyMe=1, reqId)
fBUP: deleteGroupMessageV2(groupId, cliMsgId, msgs, onlyMe=1, reqId)

1:1:    POST /api/message/delete     cmdId: 11779
Group:  POST /api/group/deletemsg    cmdId: 11834
Body: { toid/grid, cliMsgId, msgs, onlyMe, imei }
```

### Mark as Seen
```
fBUP: sendSeen(msgIds, senderId)
POST /api/message/seen  cmdId: 11150
Body: { msg_ids: [...], senderId }

fBUP: sendGroupSeen  (similar for groups)
```

### Send Delivered
```
fBUP: sendDelivered(msgIds, seen)
POST /api/message/delivered  cmdId: 11153
Body: { msg_ids: [...], seen }
```

### Renew Link (refresh expired media)
```
fBUP: renewLink(toId, msgType, msgInfo, clientId, retry, reqId, isE2ee, extra)
POST /api/message/renewlink  cmdId: 12094
```

---

## Friend APIs

### Send Friend Request
```
fBUP: sendFriendRequest(toId, message, source)

POST /api/friend/sendreq  cmdId: 11424
Body: { toid, msg, reqsrc, imei, language }
```

### Accept Friend Request
```
fBUP: acceptFriendRequest(userId)

POST /api/friend/accept  cmdId: 11427
Body: { fid, language }
```

### Remove Friend
```
fBUP: removeFriend(userId)

POST /api/friend/remove  cmdId: 11423
Body: { fid, imei }
```

### Block/Unblock Friend
```
fBUP: setBlockFriend(userId, blockType)

Block:   POST /api/friend/block    cmdId: 11422
Unblock: POST /api/friend/unblock  cmdId: 11433
Body: { fid, imei }
```

### Get User by Phone
```
fBUP: getUserByPhone(phone, reqSrc)

GET /api/friend/profile/get  cmdId: 11420
Params: { phone, avatar_size: 240, language, imei, reqSrc? }
```

### Get Friends List
```
fBUP: getFriendsList(init=0, reqId)

GET /api/social/friend/getfriends  cmdId: 11137
Params: { incInvalid: 1, page: 1, count: 20000, avatar_size, actiontime: 0, imei }
```

### Get Friend Online Status
```
fBUP: requestGetFriendOnlines()

GET /api/social/friend/onlines  cmdId: 11290
Params: { imei }
```

### Get Friend Profile (detailed)
```
fBUP: getFriendProfilev2  (instance method)
fBUP: getMiniProfile(friendIds, options, useDev)

POST /api/social/friend/getminiprofiles  cmdId: 12134
Body: { friend_ids, avatar_size, incInvalid: 1, srcReq }
```

### Report User
```
fBUP: reportUser(data)
POST /api/social/profile/reportabuse  cmdId: 31582
```

### Block Stories (Feed)
```
fBUP: updateBlockStoriesStatus(friendId, isBlock)
POST /api/friend/feed/block  cmdId: 12204
Body: { fid, isBlockFeed, imei }
```

---

## Group APIs

### Create Group
```
fBUP: createGroup(clientId, name, memberIds, nameChanged, suggestionId)

GET /api/group/create  cmdId: 11185
Params: { clientId, gname, members, suggestionId, nameChanged }
```

### Invite Members
```
fBUP: inviteMember(groupId, memberIds)

POST /api/group/invite  cmdId: 11186
Body: { grid, members }
```

### Invite Members to Multiple Groups
```
fBUP: inviteMemberMulti(groupIds, memberIds, memberType, src)

GET /api/group/invite/multi  cmdId: 12605
```

### Remove Member
```
fBUP: removeMember  (instance method)
fBUP: kickoutMemberMulti(groupIds, memberIds, src)

GET /api/group/kickout/multi  cmdId: 12606
```

### Leave Group
```
fBUP: leaveGroup(groupId, silent=0)

POST /api/group/leave  cmdId: 11189
Body: { grids: [groupId], imei, silent, language }
```

### Disperse (Delete) Group
```
fBUP: disperseGroup(groupId)

POST /api/group/disperse  cmdId: 11832
Body: { imei, grid }
```

### Update Group Name
```
fBUP: updateGroupName(groupId, newName)

POST /api/group/updateinfo  cmdId: 11188
Body: { grid, gname, imei }
```

### Update Group Settings
```
fBUP: updateGroupSetting(groupId, settings)

GET /api/group/setting/update  cmdId: 11816
Params: { ...settings, grid, imei }
```

### Change Group Owner
```
fBUP: changeGroupOwner(groupId, newOwnerId)

POST /api/group/change-owner  cmdId: 10063
Body: { grid, newAdminId, imei, language }
```

### Add/Remove Group Admin
```
fBUP: addGroupAdmin  (instance method)
fBUP: removeGroupAdmin  (instance method)
```

### Block/Unblock Member in Group
```
fBUP: blockMember(groupId, memberIds)
GET /api/group/blockedmems/add  cmdId: 11812

fBUP: unblockMember  (instance method)
```

### Get Group Info
```
fBUP: getGroupInfos(groupIds, mpage=1, mcount=50)

POST /api/group/getmg  cmdId: 12604
Body: { grids, avatar_size, member_avatar_size, mpage, mcount, imei }
```

### Get Group History
```
fBUP: getHistoryMessage(groupId, count)

GET /api/group/history  cmdId: 11240
Params: { grid, count }
```

### Upload Group Avatar
```
fBUP: updateAvatar(groupId, size, clientId, file, origW, origH)

POST /api/group/upavatar  cmdId: 11195 (FormData)
```

---

## Profile APIs

### Update My Profile
```
fBUP: updateProfileMe(profileData, ?)

POST /api/social/profile/update  cmdId: 12075
Body: { ...profileData, language }
```

### Update Profile Avatar
```
fBUP: updateProfileAvatar(avatarSize, clientId, file, metadata)

POST /api/profile/upavatar  cmdId: 11819 (FormData)
```

### Active/Deactivate Status
```
fBUP: active(status=1)    GET /api/social/profile/ping     cmdId: 11142
fBUP: deactive()          GET /api/social/profile/deactive  cmdId: 11143
```

### Get Online Status
```
fBUP: getOnlinStatus(uid, convType)

GET /api/social/profile/lastOnline  cmdId: 12090
Params: { uid, conv_type, imei }
```

---

## Conversation APIs

### Get Pinned Conversations
```
fBUP: getPinnedConversations()
GET /api/pinconvers/list  cmdId: 12120

fBUP: updatePinnedConversationsV2(conversations, actionType, tab)
POST /api/pinconvers/updatev2  cmdId: 12122
```

### Auto-Delete Conversations
```
fBUP: getAutoDeleteConvers()
GET /api/conv/autodelete/getConvers  cmdId: 12022

fBUP: updateAutoDeleteConvers({threadId, isGroup, ttl})
POST /api/conv/autodelete/updateConvers  cmdId: 12023
```

### Hidden Chats
```
fBUP: getAllListHiddenChat()
GET /api/hiddenconvers/get-all  cmdId: 10048

fBUP: updateItemHiddenChat(addThreads, delThreads)
POST /api/hiddenconvers/add-remove  cmdId: 10049
```

### Archived Chats
```
fBUP: getListArchivedChat(version)
GET /api/archivedchat/list  cmdId: 12076

fBUP: updateListArchivedChat(ids, version, actionType)
POST /api/archivedchat/update  cmdId: 12077
```

### Mute Conversations
```
fBUP: getMuteConversations  (instance method)
fBUP: setMuteConversation  (instance method)
```

### Conversation Labels
```
fBUP: getConversationLabel(?)
GET /api/convlabel/get  cmdId: 12161

fBUP: updateConversationLabel(labelData, version)
POST /api/convlabel/update  cmdId: 12160
```

---

## Alias APIs

```
fBUP: getAliasV2(page=1, count=20, src=-1, reqId)
GET /api/alias/list/v2  cmdId: 12205

fBUP: updateAlias(friendId, alias)
GET /api/alias/update  cmdId: 12201

fBUP: removeAlias(friendId)
GET /api/alias/remove  cmdId: 12202
```

---

## Poll APIs

```
fBUP: createPoll(groupId, pollData, src)
POST /api/poll/create  cmdId: 12080

fBUP: getPollDetail(groupId, pollId)
GET /api/poll/detail  cmdId: 12081

fBUP: vote(groupId, pollId, optionIds)
GET /api/poll/vote  cmdId: 12084

fBUP: addNewOptionPoll(groupId, pollId, newOptions, votedOptionIds)
GET /api/poll/option/add  cmdId: 12083

fBUP: lockPoll(pollId)
POST /api/poll/end  cmdId: 12089

fBUP: sharePoll(pollId)
POST /api/poll/share  cmdId: 12085
```

---

## Board/Topic APIs

```
fBUP: createGroupTopicv2(groupId, type, color, emoji, startTime, duration, params, needPin, pinAct, repeat, src)
POST /api/board/topic/create or /api/board/topic/createv2

fBUP: updateGroupTopicv2(...)
POST /api/board/topic/update or /api/board/topic/updatev2

fBUP: removeGroupTopicv2(groupId, topicId)
POST /api/board/topic/remove

fBUP: listBoard(groupId, boardType, page, count, lastId, lastType)
GET /api/board/list  cmdId: 12140

fBUP: getListPinTopics(groupId, boardVersion)
GET /api/board/pin/list  cmdId: 12001

fBUP: pinBoardItem(groupId, topicId, type)
GET /api/board/pin or /api/board/pinv2

fBUP: unpinBoardItem(groupId, topicId, boardVersion)
GET /api/board/unpin or /api/board/unpinv2
```

---

## Todo APIs (Personal)

```
fBUP: createTodo(todoData, src=-1)
POST /api/board/personal/todo/create  cmdId: 12413

fBUP: updateTodo(todoData)
POST /api/board/personal/todo/update  cmdId: 12414

fBUP: deleteTodo(todoId)
GET /api/board/personal/delete  cmdId: 12415

fBUP: listTodov2(scrollId, queries, offset=0, limit=20, type)
GET /api/board/personal/list  cmdId: 12416

fBUP: updateTodoStatus(todoId, status)
GET /api/board/personal/todo/status  cmdId: 12418

fBUP: todoDing(taskIds)
GET /api/board/personal/todo/ding  cmdId: 12426
```

---

## Auto-Reply / Quick Reply APIs

```
fBUP: getAutoReplyList()    GET /api/autoreply/list    cmdId: 12048
fBUP: createAutoReply(...)  POST /api/autoreply/create cmdId: 12049
fBUP: updateAutoReply(...)  POST /api/autoreply/update cmdId: 12050
fBUP: deleteAutoReply(...)  POST /api/autoreply/delete cmdId: 12051

fBUP: fetchQuickReplyList(version, lang)  GET /api/quickmessage/list    cmdId: 12025
fBUP: createQuickReplyItem(item)          GET /api/quickmessage/create  cmdId: 12029
fBUP: updateQuickReplyItem(item)          GET /api/quickmessage/update  cmdId: 12026
fBUP: deleteQuickReplyItem(itemIds)       GET /api/quickmessage/delete  cmdId: 12032
```

---

## Sticker APIs

```
fBUP: searchSticker(keyword, limit=10, srcType=0)
GET /api/message/sticker/search  cmdId: 11747

fBUP: getPersonalizedStickerList()
GET /api/message/sticker/personalized/list  cmdId: 11745

fBUP: getEffectById(effectId)
GET /api/message/effect/get  cmdId: 11743
```

---

## Cloud Message APIs

```
fBUP: getCM(groupId, globalMsgId=0, ?, count=50, reqId, timeout=10000, opts)
GET /api/cm/getrecentv2 or /api/cm/getoldv2  cmdId: 12506/12507

fBUP: getCloudMessageJump(groupId, globalMsgId, count, reqId, isJump, timeout, opts)
GET /api/cm/rgetv2  cmdId: 12508

fBUP: syncCloudMsgFirstLogin(groupIds, nretry)
GET /api/cm/mget  cmdId: 12503
```

---

## Search APIs

```
fBUP: getListRecentSearch(version)
GET /api/recentsearch/list  cmdId: 12125

fBUP: submitRecentsearch(list, version, keywords)
POST /api/recentsearch/update  cmdId: 12126
```

---

## Product Catalog APIs

```
fBUP: createProduct(data)   POST /api/prodcatalog/product/create  cmdId: 12040
fBUP: updateProduct(data)   POST /api/prodcatalog/product/update  cmdId: 12041
fBUP: removeProduct(data)   POST /api/prodcatalog/product/delete  cmdId: 12042
fBUP: getAllProductById(data) POST /api/prodcatalog/product/list   cmdId: 12039
fBUP: getProductInfo(id)    POST /api/prodcatalog/product/view    cmdId: 12057

fBUP: createCatalog(data)   POST /api/prodcatalog/catalog/create   cmdId: 12073
fBUP: updateCatalog(data)   POST /api/prodcatalog/catalog/update   cmdId: 12078
fBUP: deleteCatalog(data)   POST /api/prodcatalog/catalog/delete   cmdId: 12079
fBUP: getAllCatalog(data)    POST /api/prodcatalog/catalog/list     cmdId: 12038
```

---

## Utility APIs

### Keep Alive
```
fBUP: keepAlive()
GET /keepalive  cmdId: 11770
```

### Scan URL
```
fBUP: scanUrl(url)
POST /api/message/scanurl  cmdId: 12400
```

### Get Linked Devices
```
fBUP: getDevicesList()
GET /api/devices/linked  cmdId: 15302
```

### Network Status
```
fBUP: checkNetworkStatus()
GET /keepalive  cmdId: 11770
```

---

## Call APIs

```
fBUP: requestCall(calleeId, callId, codec, typeRequest)
GET /api/voicecall/requestcall  cmdId: 11300

fBUP: sendAnswerCall(callerId, callId, status, codec, extendData, rtcpAddr, rtpAddr, sessionId)
GET /api/voicecall/answer  cmdId: 11303

fBUP: sendCancelCall(callerId, callId, callType)
GET /api/voicecall/cancel  cmdId: 11305

fBUP: sendEndCall(uidTo, callId)
GET /api/voicecall/endcall  cmdId: 11306

// Group calls follow similar patterns at /api/voicecall/group/*
```

---

## Bank Transfer APIs

```
fBUP: getListBankCard(page, limit)
GET /api/transfer/list  cmdId: 15298 (response decrypted with decodeAES)

fBUP: createBankAccount(bin, number, holderName)
POST /api/transfer/create  cmdId: 15306

fBUP: submitBankCardInfo(binBank, numAcc, nameAcc, cliMsgId, tsMsg, destUid, destType)
POST /api/transfer/card  cmdId: 15220
```

---

## E2EE Message APIs

```
fBUP: sendMsgE2ee(action, params, isGroup, threadId, clientId, retry, cmdId, reqId, destType=3, msgType=0)

1:1:    POST /api/e2ee/pc/message/{action}
Group:  POST /api/e2ee/pc/group/{action}

Actions: "sms", "forward", "quote", etc.
```

---

## Key Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `GROUPID_PREFIX` | `"g"` | Stripped from groupId before API calls |
| `zpw_ver` | `681` | Protocol version |
| `zpw_type` | `30` | Client type (web) |
| `avatar_size` (oe) | `120` or `240` | Varies by endpoint |

---

## Session Info

| Property | Value |
|----------|-------|
| `userId` | `708728375746684590` |
| `UIN` | `f90180549d4ce9abf6d835e9f7113640` |

---

## Webpack Module Access Pattern

```javascript
// Get webpack require
let wr;
webpackJsonp.push([['__probe__'], {
  '__probe__': function(module, exports, require) { wr = require; }
}, [['__probe__']]]);

// Access modules
const httpModule = wr('fBUP').default;   // HTTP transport
const apiService = wr('dThN').default;   // Business logic
const utils = wr('z0WU');               // Utils (encodeAES, etc.)
```
