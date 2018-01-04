// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

'use strict';
import { errors } from 'azure-iot-common';
import * as machina from 'machina';
import * as tss from 'tss.js';
import { Tpm, TPM_HANDLE, TPM_ALG_ID, TPM_RC, TPM_PT, TPMA_OBJECT, TPMT_PUBLIC, TPM2B_PRIVATE } from 'tss.js';
import * as crypto from 'crypto';
import base32Encode = require('base32-encode');

import * as dbg from 'debug';

const debug = dbg('azure-iot-security-tpm:TpmSecurityClient');

export class TpmSecurityClient  {

  private static readonly _aes128SymDef: tss.TPMT_SYM_DEF_OBJECT = new tss.TPMT_SYM_DEF_OBJECT(TPM_ALG_ID.AES, 128, TPM_ALG_ID.CFB);

  private static readonly _ekPersistentHandle: TPM_HANDLE = new TPM_HANDLE(0x81010001);
  private static readonly _srkPersistentHandle: TPM_HANDLE = new TPM_HANDLE(0x81000001);
  private static readonly _idKeyPersistentHandle: TPM_HANDLE = new TPM_HANDLE(0x81000100);

  private static readonly _ekTemplate: TPMT_PUBLIC = new TPMT_PUBLIC(TPM_ALG_ID.SHA256,
    TPMA_OBJECT.restricted | TPMA_OBJECT.decrypt | TPMA_OBJECT.fixedTPM | TPMA_OBJECT.fixedParent | TPMA_OBJECT.adminWithPolicy | TPMA_OBJECT.sensitiveDataOrigin,
    new Buffer('837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa', 'hex'),
    new tss.TPMS_RSA_PARMS(TpmSecurityClient._aes128SymDef, new tss.TPMS_NULL_ASYM_SCHEME(), 2048, 0),
    new tss.TPM2B_PUBLIC_KEY_RSA());

  private static readonly _srkTemplate: TPMT_PUBLIC = new TPMT_PUBLIC(TPM_ALG_ID.SHA256,
    TPMA_OBJECT.restricted | TPMA_OBJECT.decrypt | TPMA_OBJECT.fixedTPM | TPMA_OBJECT.fixedParent | TPMA_OBJECT.noDA | TPMA_OBJECT.userWithAuth | TPMA_OBJECT.sensitiveDataOrigin,
    null,
    new tss.TPMS_RSA_PARMS(TpmSecurityClient._aes128SymDef, new tss.TPMS_NULL_ASYM_SCHEME(), 2048, 0),
    new tss.TPM2B_PUBLIC_KEY_RSA());

  private _ek: TPMT_PUBLIC = null;
  private _srk: TPMT_PUBLIC = null;
  private _registrationId: string = '';
  private _tpm: Tpm;
  private _fsm: machina.Fsm;
  private _idKeyPub: TPMT_PUBLIC = null;


  constructor(registrationId?: string, customTpm?: any) {
    /*Codes_SRS_NODE_TPM_SECURITY_CLIENT_06_002: [The `customTpm` argument, if present` will be used at the underlying TPM provider.  Otherwise the TPM provider will the tss TPM client with a parameter of `false` for simulator use.] */
    this._tpm = customTpm ? customTpm : new Tpm(false);
    if (registrationId) {
      /*Codes_SRS_NODE_TPM_SECURITY_CLIENT_06_001: [The `registrationId` argument if present will be returned as the `registrationId` for subsequent calls to `getRegistrationId`.] */
      this._registrationId = registrationId;
    }
    this._fsm = new machina.Fsm({
      initialState: 'disconnected',
      states: {
        disconnected: {
          _onEnter: (callback, err) => {
            this._ek = null;
            this._srk = null;
            if (callback) {
              if (err) {
                callback(err);
              } else {
                callback(null, null);
              }
            }
          },
          connect: (connectCallback) => this._fsm.transition('connecting', connectCallback),
          getEndorsementKey: (callback) => {
            this._fsm.handle('connect', (err, result) => {
              if (err) {
                callback(err);
              } else {
                this._fsm.handle('getEndorsementKey', callback);
              }
            });
          },
          getStorageRootKey: (callback) => {
            this._fsm.handle('connect', (err, result) => {
              if (err) {
                callback(err);
              } else {
                this._fsm.handle('getStorageRootKey', callback);
              }
            });
          },
          signWithIdentity: (dataToSign, callback) => {
            this._fsm.handle('connect', (err, result) => {
              if (err) {
                callback(err);
              } else {
                this._fsm.handle('signWithIdentity', dataToSign, callback);
              }
            });
          },
          activateSymmetricIdentity: (identityKey, callback) => {
            this._fsm.handle('connect', (err, result) => {
              if (err) {
                callback(err);
              } else {
                this._fsm.handle('activateSymmetricIdentity', identityKey, callback);
              }
            });
          },
          disconnect: (callback) => {
            if (callback) {
              callback();
            }
           }
        },
        connecting: {
          _onEnter: (callback) => {
            try {
              this._tpm.connect(() => {
                this._createPersistentPrimary('EK', tss.Endorsement, TpmSecurityClient._ekPersistentHandle, TpmSecurityClient._ekTemplate, (ekCreateErr: Error, ekPublicKey: TPMT_PUBLIC) => {
                  if (ekCreateErr) {
                    this._fsm.transition('disconnected', callback, ekCreateErr);
                  } else {
                    this._ek = ekPublicKey;
                    this._createPersistentPrimary('SRK', tss.Owner, TpmSecurityClient._srkPersistentHandle, TpmSecurityClient._srkTemplate, (srkCreateErr: Error, srkPublicKey: TPMT_PUBLIC) => {
                      if (srkCreateErr) {
                        this._fsm.transition('disconnected', callback, srkCreateErr);
                      } else {
                        this._srk = srkPublicKey;
                        this._fsm.transition('connected', callback);
                      }
                    });
                  }
                });
              });
            } catch (err) {
              this._fsm.transition('disconnected', callback, err);
            }
          },
          '*': () => this._fsm.deferUntilTransition()
        },
        connected: {
          _onEnter: (callback) => {
            callback(null);
          },
          getEndorsementKey: (callback) => {
            callback(null, this._ek.asTpm2B());
          },
          getStorageRootKey: (callback) => {
            callback(null, this._srk.asTpm2B());
          },
          signWithIdentity: (dataToSign, callback) => {
            this._signData(dataToSign, (err: Error, signedData: Buffer) => {
              if (err) {
                debug('Error from signing data: ' + err);
                this._fsm.transition('disconnected', callback, err);
              } else {
                callback(null, signedData);
              }
            });
          },
          activateSymmetricIdentity: (identityKey, callback) => {
            this._activateSymmetricIdentity(identityKey, (err: Error) => {
              if (err) {
                debug('Error from activate: ' + err);
                this._fsm.transition('disconnected', callback, err);
              } else {
                callback(null);
              }
            });
          },
        }
      }
    });
  }

  getEndorsementKey(callback: (err: Error, endorsementKey: Buffer) => void): void {
      this._fsm.handle('getEndorsementKey', callback);
  }

  getStorageRootKey(callback: (err: Error, storageKey: Buffer) => void): void {
    this._fsm.handle('getStorageRootKey', callback);
  }

  signWithIdentity(dataToSign: Buffer, callback: (err: Error, signedData: Buffer) => void): void {
    if (dataToSign === null || dataToSign.length === 0) {
        throw new ReferenceError('\'dataToSign\' cannot be \'' + dataToSign + '\'');
    }
    if (this._idKeyPub == null) {
        throw new errors.InvalidOperationError('activateSymmetricIdentity must be invoked before any signing is attempted.');
    }
    this._fsm.handle('signWithIdentity', dataToSign, callback);
  }

  activateSymmetricIdentity(identityKey: Buffer, callback: (err: Error, returnedActivate: Buffer) => void): void {
    if (identityKey === null || identityKey.length === 0) {
      throw new ReferenceError('\'identityKey\' cannot be \'' + identityKey + '\'');
    }
    this._fsm.handle('activateSymmetricIdentity', identityKey, callback);
  }

  getRegistrationId(callback: (err: Error, registrationId: string) => void): void {
    if (this._registrationId) {
      /*Codes_SRS_NODE_TPM_SECURITY_CLIENT_06_003: [If the TpmSecurityClient was given a `registrationId` at creation, that `registrationId` will be returned.] */
      callback(null, this._registrationId);
    } else {
      this.getEndorsementKey( (endorsementError: Error, endorsementKey: Buffer) => {
        if (endorsementError) {
          /*Codes_SRS_NODE_TPM_SECURITY_CLIENT_06_005: [Any errors from interacting with the TPM hardware will cause an SecurityDeviceError to be returned in the err parameter of the callback.] */
          callback(endorsementError, null);
        } else {
        /*Codes_SRS_NODE_TPM_SECURITY_CLIENT_06_004: [If not provided, the `registrationId` will be constructed and returned as follows:
          The endorsementKey will be queried.
          The endorsementKey will be hashed utilizing SHA256.
          The resultant digest will be bin32 encoded in conformance with the `RFC4648` specification.
          The resultant string will have terminating `=` characters removed.] */
          const hasher = crypto.createHash('sha256');
          hasher.update(endorsementKey);
          this._registrationId = (base32Encode(hasher.digest(), 'RFC4648').toLowerCase()).replace(/=/g, '');
          callback(null, this._registrationId);
        }
      });
    }
  }

  private _createPersistentPrimary(name: string, hierarchy: TPM_HANDLE, handle: TPM_HANDLE, template: TPMT_PUBLIC, callback: (err: Error, resultPublicKey: TPMT_PUBLIC) => void): void {
    this._tpm.allowErrors().ReadPublic(handle, (resp: tss.ReadPublicResponse) => {
      let rc = this._tpm.getLastResponseCode();
      debug('ReadPublic(' + name + ') returned ' + TPM_RC[rc] +  (rc === TPM_RC.SUCCESS ? '; PUB: ' + resp.outPublic.toString() : ''));
      if (rc !== TPM_RC.SUCCESS) {
        this._tpm.withSession(tss.NullPwSession).CreatePrimary(hierarchy, new tss.TPMS_SENSITIVE_CREATE(), template, null, null, (resp: tss.CreatePrimaryResponse) => {
          debug('CreatePrimary(' + name + ') returned ' + TPM_RC[this._tpm.getLastResponseCode()] + '; pub size: ' + (resp.outPublic.unique as tss.TPM2B_PUBLIC_KEY_RSA).buffer.length);
          this._tpm.withSession(tss.NullPwSession).EvictControl(tss.Owner, resp.handle, handle, () => {
            debug('EvictControl(0x' + resp.handle.handle.toString(16) + ', 0x' + handle.handle.toString(16) + ') returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
            this._tpm.FlushContext(resp.handle, () => {
              debug('FlushContext(TRANSIENT_' + name + ') returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
              callback(null, resp.outPublic);
            });
          });
        });
      } else {
        callback(null, resp.outPublic);
      }
    });
  }

  private _signData(dataToSign: Buffer, callback: (err: Error, signedData: Buffer) => void): void {

    const idKeyHashAlg: TPM_ALG_ID = (<tss.TPMS_SCHEME_HMAC>(<tss.TPMS_KEYEDHASH_PARMS>this._idKeyPub.parameters).scheme).hashAlg;

    this._tpm.GetCapability(tss.TPM_CAP.TPM_PROPERTIES, TPM_PT.INPUT_BUFFER, 1, (caps: tss.GetCapabilityResponse) => {
      const props = <tss.TPML_TAGGED_TPM_PROPERTY>caps.capabilityData;
      if (props.tpmProperty.length !== 1 || props.tpmProperty[0].property !== TPM_PT.INPUT_BUFFER) {
        callback(new errors.SecurityDeviceError('Unexpected result of TPM2_GetCapability(TPM_PT.INPUT_BUFFER)'), null);
      } else {
        const maxInputBuffer: number = props.tpmProperty[0].value;
        if (dataToSign.length <= maxInputBuffer) {
          this._tpm.withSession(tss.NullPwSession).HMAC(TpmSecurityClient._idKeyPersistentHandle, dataToSign, idKeyHashAlg, (signature: Buffer) => {
            callback(null, signature);
          });
        } else {
          let curPos: number = 0;
          let bytesLeft: number = dataToSign.length;
          let hSequence: TPM_HANDLE = null;
          let signature = new Buffer(0);
          let loopFn = () => {
            if (bytesLeft > maxInputBuffer) {
                this._tpm.withSession(tss.NullPwSession).SequenceUpdate(hSequence, dataToSign.slice(curPos, curPos + maxInputBuffer), loopFn);
                console.log('SequenceUpdate() invoked for slice [' + curPos + ', ' + (curPos + maxInputBuffer) + ']');
                bytesLeft -= maxInputBuffer;
                curPos += maxInputBuffer;
            } else {
              this._tpm.withSession(tss.NullPwSession).SequenceComplete(hSequence, dataToSign.slice(curPos, curPos + bytesLeft), new TPM_HANDLE(tss.TPM_RH.NULL), (resp: tss.SequenceCompleteResponse) => {
                console.log('SequenceComplete() succeeded; signature size ' + signature.length);
              });
            }
          };
          this._tpm.withSession(tss.NullPwSession).HMAC_Start(TpmSecurityClient._idKeyPersistentHandle, signature, idKeyHashAlg, (hSeq: TPM_HANDLE) => {
            console.log('HMAC_Start() returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
            hSequence = hSeq;
            loopFn();
          });
        }
      }
    });
  }

  private _activateSymmetricIdentity(activationBlob: Buffer, activateCallback: (err: Error) => void): void {

    let currentPosition = 0;
    let credentialBlob: tss.TPMS_ID_OBJECT;
    let encodedSecret = new tss.TPM2B_ENCRYPTED_SECRET();
    let idKeyDupBlob = new TPM2B_PRIVATE();
    let encWrapKey = new tss.TPM2B_ENCRYPTED_SECRET();

    //
    // Unmarshal components of the activation blob received from the provisioning service.
    //
    [credentialBlob, currentPosition] = tss.marshal.sizedFromTpm(tss.TPMS_ID_OBJECT, activationBlob, 2, currentPosition);
    debug('credentialBlob end: ' + currentPosition);
    currentPosition = encodedSecret.fromTpm(activationBlob, currentPosition);
    debug('encodedSecret end: ' + currentPosition);
    currentPosition = idKeyDupBlob.fromTpm(activationBlob, currentPosition);
    debug('idKeyDupBlob end: ' + currentPosition);
    currentPosition = encWrapKey.fromTpm(activationBlob, currentPosition);
    debug('encWrapKey end: ' + currentPosition);
    [this._idKeyPub, currentPosition] = tss.marshal.sizedFromTpm(TPMT_PUBLIC, activationBlob, 2, currentPosition);
    debug('idKeyPub end: ' + currentPosition);

    //
    // Start a policy session to be used with ActivateCredential()
    //

    this._tpm.GetRandom(20, (nonce: Buffer) => {
      this._tpm.StartAuthSession(null, null, nonce, null, tss.TPM_SE.POLICY, tss.NullSymDef, TPM_ALG_ID.SHA256, (resp: tss.StartAuthSessionResponse) => {
        debug('StartAuthSession(POLICY_SESS) returned ' + TPM_RC[this._tpm.getLastResponseCode()] + '; sess handle: ' + resp.handle.handle.toString(16));
        if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
          activateCallback(new errors.SecurityDeviceError('Authorization session unable to be created.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
        } else {
          let policySession = new tss.Session(resp.handle, resp.nonceTPM);

          //
          // Apply the policy necessary to authorize an EK on Windows
          //

          this._tpm.withSession(tss.NullPwSession).PolicySecret(tss.Endorsement, policySession.SessIn.sessionHandle, null, null, null, 0, (resp: tss.PolicySecretResponse) => {
            debug('PolicySecret() returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
            if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
              activateCallback(new errors.SecurityDeviceError('Upable to apply the necessary policy to authorize the EK.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
            } else {

              //
              // Use ActivateCredential() to decrypt symmetric key that is used as an inner protector
              // of the duplication blob of the new Device ID key generated by DRS.
              //

              this._tpm.withSessions(tss.NullPwSession, policySession).ActivateCredential(TpmSecurityClient._srkPersistentHandle, TpmSecurityClient._ekPersistentHandle, credentialBlob, encodedSecret.secret, (innerWrapKey: Buffer) => {
                debug('ActivateCredential() returned ' + TPM_RC[this._tpm.getLastResponseCode()] + '; innerWrapKey size ' + innerWrapKey.length);
                if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
                  activateCallback(new errors.SecurityDeviceError('Upable to decrypt the symmetric key used to protect duplication blob.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
                } else {

                  //
                  // Initialize parameters of the symmetric key used by DRS
                  // Note that the client uses the key size chosen by DRS, but other parameters are fixed (an AES key in CFB mode).
                  //
                  let symDef = new tss.TPMT_SYM_DEF_OBJECT(TPM_ALG_ID.AES, innerWrapKey.length * 8, TPM_ALG_ID.CFB);

                  //
                  // Import the new Device ID key issued by DRS to the device's TPM
                  //

                  this._tpm.withSession(tss.NullPwSession).Import(TpmSecurityClient._srkPersistentHandle, innerWrapKey, this._idKeyPub, idKeyDupBlob, encWrapKey.secret, symDef, (idKeyPriv: TPM2B_PRIVATE) => {
                    debug('Import() returned ' + TPM_RC[this._tpm.getLastResponseCode()] + '; idKeyPriv size ' + idKeyPriv.buffer.length);
                    if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
                      activateCallback(new errors.SecurityDeviceError('Upable to import the device id key into the TPM.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
                    } else {

                      //
                      // Load the imported key into the TPM
                      //

                      this._tpm.withSession(tss.NullPwSession).Load(TpmSecurityClient._srkPersistentHandle, idKeyPriv, this._idKeyPub, (hIdKey: TPM_HANDLE) => {
                        debug('Load() returned ' + TPM_RC[this._tpm.getLastResponseCode()] + '; ID key handle: 0x' + hIdKey.handle.toString(16));
                        if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
                          activateCallback(new errors.SecurityDeviceError('Upable to load the device id key into the TPM.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
                        } else {

                          //
                          // Remove possibly existing persistent instance of the previous Device ID key
                          //

                          this._tpm.allowErrors().withSession(tss.NullPwSession).EvictControl(tss.Owner, TpmSecurityClient._idKeyPersistentHandle, TpmSecurityClient._idKeyPersistentHandle, () => {

                            //
                            // Persist the new Device ID key
                            //

                            this._tpm.withSession(tss.NullPwSession).EvictControl(tss.Owner, hIdKey, TpmSecurityClient._idKeyPersistentHandle, () => {
                              console.log('EvictControl(0x' + hIdKey.handle.toString(16) + ', 0x' + TpmSecurityClient._idKeyPersistentHandle.handle.toString(16) + ') returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
                              if (this._tpm.getLastResponseCode() !== TPM_RC.SUCCESS) {
                                activateCallback(new errors.SecurityDeviceError('Upable to persist the device id key into the TPM.  RC value: ' + TPM_RC[this._tpm.getLastResponseCode()].toString()));
                              } else {

                                //
                                // Free the ID Key transient handle and the session object.  Doesn't matter if it "fails".  Go on at this point./
                                //

                                this._tpm.FlushContext(hIdKey, () => {
                                  debug('FlushContext(TRANS_ID_KEY) returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
                                  this._tpm.FlushContext(policySession.SessIn.sessionHandle, () => {
                                    debug('FlushContext(POLICY_SESS) returned ' + TPM_RC[this._tpm.getLastResponseCode()]);
                                    activateCallback(null);
                                  });
                                });
                              }
                            });
                          });
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }
      });
    });
  }
}

