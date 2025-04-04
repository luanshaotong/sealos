import React, { useMemo, useState } from 'react';
import {
  Box,
  Flex,
  useTheme,
  Tag,
  Accordion,
  AccordionButton,
  AccordionItem,
  AccordionPanel,
  AccordionIcon
} from '@chakra-ui/react';
import type { AppDetailType } from '@/types/app';
import { useCopyData, printMemory } from '@/utils/tools';
import { useUserStore } from '@/store/user';
import styles from '../index.module.scss';
import dynamic from 'next/dynamic';
const ConfigMapDetailModal = dynamic(() => import('./ConfigMapDetailModal'));
import { MOCK_APP_DETAIL } from '@/mock/apps';
import { useTranslation } from 'next-i18next';
import { MyTooltip } from '@sealos/ui';
import GPUItem from '@/components/GPUItem';
import MyIcon from '@/components/Icon';

const AppBaseInfo = ({ app = MOCK_APP_DETAIL }: { app: AppDetailType }) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { copyData } = useCopyData();
  const { userSourcePrice } = useUserStore();
  const [detailConfigMap, setDetailConfigMap] = useState<{
    mountPath: string;
    value: string;
  }>();

  const appInfoTable = useMemo<
    {
      name: string;
      iconName: string;
      items: {
        label: string;
        value?: string;
        copy?: string;
        render?: React.ReactNode;
      }[];
    }[]
  >(() => {
    const images =
      app.containers?.map((container) => {
        return {
          label: `${t('Image Name')} ${container.secret.use ? '(Private)' : ''}`,
          value: app.imageName
        };
      }) || [];
    const cpu = app.containers?.reduce((acc, container) => acc + container.cpu, 0);
    const memory = app.containers?.reduce((acc, container) => acc + container.memory, 0);

    return [
      {
        name: 'Basic Information',
        iconName: 'formInfo',
        items: [
          { label: 'node_info ', value: app.nodeName },
          { label: 'Creation Time', value: app.createTime },
          ...images,
          { label: 'Limit CPU', value: `${cpu / 1000} Core` },
          {
            label: 'Limit Memory',
            value: printMemory(memory)
          },
          ...(userSourcePrice?.gpu
            ? [
                {
                  label: 'GPU',
                  render: <GPUItem gpu={app.gpu} />
                }
              ]
            : [])
        ]
      },
      {
        name: 'Deployment Mode',
        iconName: 'deployMode',
        items: app.hpa.use
          ? [
              { label: `${app.hpa.target} ${t('target_value')}`, value: `${app.hpa.value}%` },
              {
                label: 'Number of Instances',
                value: `${app.hpa.minReplicas} ~ ${app.hpa.maxReplicas}`
              }
            ]
          : [{ label: `Number of Instances`, value: `${app.replicas}` }]
      }
    ];
  }, [app]);

  const appTags = useMemo(() => {
    const networks = app.containers?.flatMap((container) => container.networks);
    return [
      ...(networks?.some((item) => item.openPublicDomain) ? ['Public Access'] : []),
      ...(app.hpa.use ? ['Auto scaling'] : ['Fixed instance']),
      ...(app.storeList.length > 0 ? ['Stateful'] : ['Stateless'])
    ];
  }, [app]);

  const modelInfo = useMemo(() => {
   console.log("apppppp", app)
  }, [app]);

  return (
    <Box px={6} py={7} position={'relative'}>
      <>
        <Flex alignItems={'center'} color={'grayModern.600'} fontSize={'base'} fontWeight={'bold'}>
          <MyIcon w={'16px'} name={'appType'}></MyIcon>
          <Box ml={2}>{t('Application Type')}</Box>
        </Flex>
        <Flex mt={5} gap={'8px'}>
          {appTags.map((tag) => (
            <Tag
              key={tag}
              borderRadius={'33px'}
              backgroundColor={'grayModern.100'}
              px={'12px'}
              py={'6px'}
            >
              {t(tag)}
            </Tag>
          ))}
        </Flex>
      </>
      {appInfoTable.map((info, index) => (
        <Box
          _notFirst={{
            mt: 6
          }}
          key={info.name + index}
        >
          <Flex
            alignItems={'center'}
            color={'grayModern.600'}
            fontSize={'base'}
            fontWeight={'bold'}
          >
            <MyIcon w={'16px'} name={info.iconName as any}></MyIcon>
            <Box ml={2}>{t(info.name)}</Box>
          </Flex>
          <Box mt={3} p={4} backgroundColor={'grayModern.50'} borderRadius={'md'}>
            {info.items.map((item, i) => (
              <Flex
                key={item.label + i}
                flexWrap={'wrap'}
                _notFirst={{
                  mt: 4
                }}
              >
                <Box flex={'0 0 110px'} w={0} color={'grayModern.900'} fontSize={'12px'}>
                  {t(item.label)}
                </Box>
                <Box
                  fontSize={'12px'}
                  color={'grayModern.600'}
                  flex={'1 0 0'}
                  textOverflow={'ellipsis'}
                  overflow={'hidden'}
                  whiteSpace={'nowrap'}
                >
                  <MyTooltip label={item.value}>
                    <Box
                      as="span"
                      cursor={!!item.copy ? 'pointer' : 'default'}
                      onClick={() => item.value && !!item.copy && copyData(item.copy)}
                    >
                      {item.render ? item.render : item.value}
                    </Box>
                  </MyTooltip>
                </Box>
              </Flex>
            ))}
          </Box>
        </Box>
      ))}
      {app?.containers?.map((container) => {
        return (
          <Box key={container.name} mt={6}>
            <Flex
              alignItems={'center'}
              color={'grayModern.600'}
              fontSize={'base'}
              fontWeight={'bold'}
            >
              <MyIcon w={'16px'} name={'settings'}></MyIcon>
              <Box ml={2}>{t('Advanced Configuration')}</Box>
            </Flex>
            <Box
              mt={2}
              pt={4}
              backgroundColor={'grayModern.50'}
              borderRadius={'md'}
              fontSize={'12px'}
              color={'grayModern.600'}
              fontWeight={'bold'}
            >
              {[
                { label: 'Command', value: container.runCMD || 'Not Configured' },
                { label: 'Parameters', value: container.cmdParam || 'Not Configured' }
              ].map((item) => (
                <Flex
                  key={item.label}
                  _notFirst={{
                    mt: 4
                  }}
                  px={4}
                >
                  <Box flex={'0 0 80px'} w={0}>
                    {t(item.label)}
                  </Box>
                  <MyTooltip label={item.value}>
                    <Box
                      flex={'1 0 0'}
                      w={'0'}
                      textAlign={'right'}
                      color={'grayModern.500'}
                      textOverflow={'ellipsis'}
                      overflow={'hidden'}
                      whiteSpace={'nowrap'}
                      onClick={() => copyData(item.value)}
                      cursor={'pointer'}
                    >
                      {t(item.value)}
                    </Box>
                  </MyTooltip>
                </Flex>
              ))}
              {/* env */}
              <Accordion allowToggle defaultIndex={0} mt={4}>
                <AccordionItem borderBottom={0} borderColor={'#EFF0F1'}>
                  <AccordionButton
                    py={4}
                    display={'flex'}
                    textAlign={'left'}
                    _hover={{ backgroundColor: 'transparent' }}
                    fontSize={'12px'}
                    color={'grayModern.600'}
                    fontWeight={'bold'}
                  >
                    <Box flex={1}>{t('Environment Variables')}</Box>
                    <AccordionIcon />
                  </AccordionButton>
                  <AccordionPanel pt={0} pb={container.envs.length === 0 ? 0 : 3}>
                    {container.envs?.length > 0 && (
                      <Flex
                        flexDirection={'column'}
                        border={theme.borders.base}
                        bg={'#fff'}
                        borderRadius={'md'}
                      >
                        {container.envs.map((env, index) => {
                          const valText = env.value
                            ? env.value
                            : env.valueFrom
                            ? 'value from | ***'
                            : '';
                          return (
                            <Flex
                              key={env.key}
                              gap={'24px'}
                              px="10px"
                              py="8px"
                              borderBottom={'1px solid'}
                              borderBottomColor={
                                index !== container.envs.length - 1
                                  ? 'grayModern.150'
                                  : 'transparent'
                              }
                            >
                              <Box flex={1} maxW={'40%'} overflowWrap={'break-word'}>
                                {env.key}
                              </Box>
                              <MyTooltip label={valText}>
                                <Box
                                  flex={1}
                                  className={styles.textEllipsis}
                                  style={{
                                    userSelect: 'auto',
                                    cursor: 'pointer'
                                  }}
                                  onClick={() => copyData(valText)}
                                >
                                  {valText}
                                </Box>
                              </MyTooltip>
                            </Flex>
                          );
                        })}
                      </Flex>
                    )}
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
              {/* configMap */}
              <Accordion allowToggle defaultIndex={0}>
                <AccordionItem borderBottom={0} borderColor={'#EFF0F1'}>
                  <AccordionButton
                    display={'flex'}
                    textAlign={'left'}
                    py={4}
                    _hover={{ backgroundColor: 'transparent' }}
                    fontSize={'12px'}
                    color={'grayModern.600'}
                    fontWeight={'bold'}
                  >
                    <Box flex={1}>{t('Configuration File')}</Box>
                    <AccordionIcon />
                  </AccordionButton>
                  <AccordionPanel py={0}>
                    <Box
                      borderRadius={'md'}
                      overflow={'hidden'}
                      bg={'#FFF'}
                      {...(app.configMapList.length > 0
                        ? {
                            mb: 3,
                            border: theme.borders.base
                          }
                        : {})}
                    >
                      {app.configMapList.map((item) => (
                        <Flex
                          key={item.mountPath}
                          alignItems={'center'}
                          px={4}
                          py={2}
                          cursor={'pointer'}
                          onClick={() => setDetailConfigMap(item)}
                          _notLast={{
                            borderBottom: theme.borders.base
                          }}
                        >
                          <MyIcon name={'configMap'} />
                          <Box ml={4} flex={'1 0 0'} w={0}>
                            <Box color={'grayModern.900'}>{item.mountPath}</Box>
                            <Box
                              className={styles.textEllipsis}
                              color={'grayModern.900'}
                              fontSize={'sm'}
                            >
                              {item.value}
                            </Box>
                          </Box>
                        </Flex>
                      ))}
                    </Box>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
              {/* store */}
              <Accordion allowToggle defaultIndex={0}>
                <AccordionItem borderBottom={0} borderColor={'#EFF0F1'}>
                  <AccordionButton
                    display={'flex'}
                    textAlign={'left'}
                    py={4}
                    _hover={{ backgroundColor: 'transparent' }}
                    fontSize={'12px'}
                    color={'grayModern.600'}
                    fontWeight={'bold'}
                  >
                    <Box flex={1}>{t('Storage')}</Box>
                    <AccordionIcon />
                  </AccordionButton>
                  <AccordionPanel py={0}>
                    <Box
                      borderRadius={'md'}
                      overflow={'hidden'}
                      bg={'#FFF'}
                      {...(app.storeList.length > 0
                        ? {
                            mb: 4,
                            border: theme.borders.base
                          }
                        : {})}
                    >
                      {app.storeList.map((item) => (
                        <Flex
                          key={item.path}
                          alignItems={'center'}
                          px={4}
                          py={1}
                          _notLast={{
                            borderBottom: theme.borders.base
                          }}
                        >
                          <MyIcon name={'store'} />
                          <Box ml={4} flex={'1 0 0'} w={0}>
                            <Box color={'grayModern.900'} fontWeight={'bold'}>
                              {item.path}
                            </Box>
                            <Box
                              className={styles.textEllipsis}
                              color={'grayModern.900'}
                              fontSize={'sm'}
                            >
                              {item.value} Gi
                            </Box>
                          </Box>
                        </Flex>
                      ))}
                    </Box>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            </Box>
          </Box>
        );
      })}

      {detailConfigMap && (
        <ConfigMapDetailModal {...detailConfigMap} onClose={() => setDetailConfigMap(undefined)} />
      )}
    </Box>
  );
};

export default React.memo(AppBaseInfo);
