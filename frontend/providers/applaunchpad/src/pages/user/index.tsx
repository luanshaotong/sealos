import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteImageHub, deleteResourceQuotas, getResourceQuotas, updateResourceQuotas, uploadImageHub } from '@/api/app';
import FileSelect from '@/components/FileSelect';
import MyIcon from '@/components/Icon';
import { ImageHubItem } from '@/pages/api/imagehub/get';
import { formatPodTime } from '@/utils/tools';
import { getRoles } from '@/api/roles'
import {
  Box,
  Button,
  Center,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  HStack,
  Icon,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  useDisclosure,
  useTheme,
  Table,
  Thead,
  Tbody,
  Tfoot,
  Tr,
  Th,
  Td,
  TableCaption,
  TableContainer,
  Select,
  useToast,
  InputGroup,
  InputRightAddon
} from '@chakra-ui/react';
import type { ThemeType } from '@sealos/ui';
import { useMessage } from '@sealos/ui';
import dayjs from 'dayjs';
import { debounce } from 'lodash';
import { useTranslation } from 'next-i18next';
import { useRouter } from 'next/router';
import { syncConfigMap } from '@/api/configMap'
import { createNamespace } from '@/api/platform';
import { useForm } from 'react-hook-form';

const AppList = ({
  apps = [],
  namespaces,
  refetchApps,
  onSearch
}: {
  namespaces: string[];
  apps: ImageHubItem[];
  refetchApps: () => void;
  onSearch: (value: string) => void;
}) => {
  const [userDataList, setUserDataList] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [currentData, setCurrentData] = useState<any>(null)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [roleId, setRoleId] = useState<any>(null)
  const toast = useToast();
  const {
    register,
    control,
    setValue,
    getValues,
    handleSubmit,
    formState: { errors }
  } = useForm<any>({
    defaultValues: currentData
  })
  const columns = [
    { title: '用户名', field: 'username' },
    { title: '命名空间', field: 'namespace' },
    { title: '创建时间', field: 'createtime', render: (row: any) => dayjs(row.createtime).format('YYYY-MM-DD HH:mm:ss') },
    { title: 'cpu', field: 'cpu' },
    { title: '内存', field: 'memory' },
    { title: '磁盘数量', field: 'persistentvolumeclaims' },
    { title: '网络服务数量', field: 'services' },
    { title: '存储', field: 'storage' },
    { title: '操作' }
  ];
  const [roles, setRoles] = useState<any[]>([])

  const Label = ({
    children,
    w = 200,
    ...props
  }: {
    children: string;
    w?: number | 'auto';
    [key: string]: any;
  }) => (
    <Box
      flex={`0 0 ${w === 'auto' ? 'auto' : `${w}px`}`}
      color={'grayModern.900'}
      fontWeight={'bold'}
      userSelect={'none'}
      {...props}
    >
      {children}
    </Box>
  );

  useEffect(() => {
    initUserDataAndResource()
    fetchRoleList()
  }, [])

  const initUserDataAndResource = async () => {
    const resp = await getResourceQuotas()
    if (resp) {
      setUserDataList(resp)
    }
  }

  const onOpen = () => {
    setIsOpen(true)
  }

  const onClose = () => {
    setIsOpen(false)
  }
  const fetchRoleList = async () => {
    const res = await getRoles({})
    setRoles(res)
  }

  const onConfirm = async () => {
    try {
      const resp = await createNamespace({
        ns: username,
        roleId: roleId
      })
      if (resp) {
        await syncConfigMap()
        toast({
          status: 'success',
          title: '创建成功'
        })
        onClose()
        initUserDataAndResource()
      }
    } catch (error: any) {
      return toast({
        status: 'error',
        title: error.message
      });
    }
  }

  const onEdit = async (data: any) => {
    setCurrentData({
      namespace: data.namespace,
      username: data.username,
      services: Number(data.services),
      requestsStorage: Number(data.storage.split('Gi')[0]),
      persistentVolumeClaims: Number(data.persistentvolumeclaims),
      limitsCpu: Number(data.cpu),
      limitsMemory: Number(data.memory.split('Gi')[0]),
    })
    setRoleId(data.roleId)
    setIsEditOpen(true)
  }

  const onDelete = async (data: any) => {
    setCurrentData(data)
    setIsDeleteOpen(true)
  }

  const onDeleteClose = () => {
    setCurrentData(null)
    setIsDeleteOpen(false)
  }

  const onDeleteConfirm = async () => {
    try {
      if (currentData) {
        const resp = await deleteResourceQuotas(currentData.namespace)
        if (resp) {
          toast({
            status: 'success',
            title: '删除成功'
          })
          onDeleteClose()
          initUserDataAndResource()
        }
      }
    } catch (error) {
    }
  }

  const onEditClose = () => {
    setCurrentData(null)
    setIsEditOpen(false)
  }

  const onEditConfirm = async () => {
    try {
      if (currentData) {
        const resp = await updateResourceQuotas(currentData.namespace, {
          namespace: currentData.namespace,
          username: currentData.username,
          roleId: roleId,
          limits: {
            services: currentData.services,
            requestsStorage: `${currentData.requestsStorage}Gi`,
            persistentVolumeClaims: currentData.persistentVolumeClaims,
            limitsCpu: `${currentData.limitsCpu}`,
            limitsMemory: `${currentData.limitsMemory}Gi`
          }
        })
        if (resp) {
          toast({
            status: 'success',
            title: '编辑成功'
          })
          onEditClose()
          initUserDataAndResource()
        }
      }
    } catch (error) {
    }
  }

  return (
    <Box backgroundColor={'grayModern.100'} px={'32px'} pb={5} minH={'100%'}>
      <Flex h={'88px'} alignItems={'center'} justifyContent={'space-between'}>
        <Flex alignItems={'center'}>
          <Center
            w="46px"
            h={'46px'}
            mr={4}
            backgroundColor={'#FEFEFE'}
            borderRadius={'md'}
          >
            <MyIcon name="logo" w={'24px'} h={'24px'} />
          </Center>
          <Box fontSize={'xl'} color={'grayModern.900'} fontWeight={'bold'}>
            用户管理
          </Box>
        </Flex>
        <Button onClick={onOpen}>创建用户</Button>
      </Flex>

      <TableContainer>
        <Table variant="simple" backgroundColor={'white'} color={'black'}>
          <Thead>
            <Tr>
              {columns.map((column, index) => (
                <Th key={index}>{column.title}</Th>
              ))}
            </Tr>
          </Thead>
          <Tbody>
            {userDataList.map((row, rowIndex) => (
              <Tr key={rowIndex}>
                {columns.map((column, colIndex) => (
                  column.title === '操作' ?
                    <Td key={`${rowIndex}-${colIndex}`}>
                      <Flex gap={'1'}>
                        <Button size="sm" onClick={() => { onEdit(row) }}>编辑</Button>
                        <Button bgColor={'red'} colorScheme='red' _hover={{ bgColor: 'red' }} size="sm" onClick={() => { onDelete(row) }}>删除</Button>
                      </Flex>
                    </Td> :
                    <Td key={`${rowIndex}-${colIndex}`}>
                      {column.render ? column.render(row) : row[column.field as keyof typeof row]}
                    </Td>
                ))}
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>

      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>新增用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'center'} mb={5}>
                <Label>用户名</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  width={300}
                  style={{borderColor:errors.username ? 'red' : '#02A7F0'}}
                  // {...register(`username`, {
                  //   required: '请输入'
                  // })}
                  autoFocus={true}
                  maxLength={20}
                />
              </Flex>
            </FormControl>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'center'} mb={5}>
                <Label>角色</Label>
                <Select
                  style={{ borderColor:errors.roleId ? 'red' : '#02A7F0' }}
                  width={300}
                  mr={4}
                  value={roleId}
                  {...register(`roleId`, {
                    required: '请输入'
                  })}
                  onChange={(e) => {
                    setRoleId(e.target.value)
                  }}
                >
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </Flex>
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={handleSubmit(onConfirm)}>
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>删除用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <p>确定删除吗？</p>
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={onDeleteConfirm}>
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isEditOpen} onClose={onEditClose} size={'4xl'} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>编辑用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'center'} mb={5}>
                <Label>用户名</Label>
                <Input
                  type='text'
                  value={currentData?.username}
                  style={{borderColor:errors.username ? 'red' : '#02A7F0'}}
                  {...register(`username`, {
                    required: '请输入'
                  })}
                  onChange={(e) => {
                    setCurrentData({
                      ...currentData,
                      username: e.target.value
                    })
                  }}
                  autoFocus={true}
                  maxLength={20}
                />
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>角色</Label>
                <Select
                  value={roleId}
                  onChange={(e) => {
                    setRoleId(e.target.value)
                  }}
                  style={{borderColor:errors.username ? 'red' : '#02A7F0'}}
                  // {...register(`roleId`, {
                  //   required: '请输入'
                  // })}
                  width={300}
                >
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>命名空间</Label>
                <Input
                  value={currentData?.namespace}
                  autoFocus={true}
                  maxLength={60}
                  disabled={true}
                />
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>网络服务数量</Label>
                <Input
                  type='number'
                  value={currentData?.services}
                  style={{borderColor:errors.services ? 'red' : '#02A7F0'}}
                  {...register(`services`, {
                    required: '请输入'
                  })}
                  onInput={(e:any) => {
                    if (e.target.value.length > 7) {
                      e.target.value = e.target.value.slice(0, 7);
                    }
                  }}
                  onChange={(e) => {
                    setCurrentData({
                      ...currentData,
                      services: Number(e.target.value)
                    })
                  }}
                  autoFocus={true}
                  maxLength={7}
                />
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>请求存储</Label>
                <InputGroup>
                  <Input
                    type='number'
                    value={currentData?.requestsStorage}
                    onInput={(e:any) => {
                      if (e.target.value.length > 7) {
                        e.target.value = e.target.value.slice(0, 7);
                      }
                    }}
                    style={{borderColor:errors.requestsStorage ? 'red' : '#02A7F0'}}
                    {...register(`requestsStorage`, {
                      required: '请输入'
                    })}
                    onChange={(e) => {
                      setCurrentData({
                        ...currentData,
                        requestsStorage: Number(e.target.value)
                      })
                    }}
                    autoFocus={true}
                    maxLength={7}
                  />
                  <InputRightAddon style={{ height: 32, borderColor: '#02A7F0' }}>Gi</InputRightAddon>
                </InputGroup>
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>磁盘数量</Label>
                <Input
                  type='number'
                  value={currentData?.persistentVolumeClaims}
                  onInput={(e:any) => {
                    if (e.target.value.length > 7) {
                      e.target.value = e.target.value.slice(0, 7);
                    }
                  }}
                  style={{borderColor:errors.persistentVolumeClaims ? 'red' : '#02A7F0'}}
                  {...register(`persistentVolumeClaims`, {
                    required: '请输入'
                  })}
                  onChange={(e) => {
                    setCurrentData({
                      ...currentData,
                      persistentVolumeClaims: Number(e.target.value)
                    })
                  }}
                  autoFocus={true}
                  maxLength={60}
                />
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>CPU 限制</Label>
                <Input
                  type='number'
                  value={currentData?.limitsCpu}
                  onInput={(e:any) => {
                    if (e.target.value.length > 7) {
                      e.target.value = e.target.value.slice(0, 7);
                    }
                  }}
                  style={{borderColor:errors.limitsCpu ? 'red' : '#02A7F0'}}
                  {...register(`limitsCpu`, {
                    required: '请输入'
                  })}
                  onChange={(e) => {
                    setCurrentData({
                      ...currentData,
                      limitsCpu: Number(e.target.value)
                    })
                  }}
                  autoFocus={true}
                  maxLength={60}
                />
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>内存限制</Label>
                <InputGroup>
                  <Input
                    type='number'
                    value={currentData?.limitsMemory}
                    onInput={(e:any) => {
                    if (e.target.value.length > 7) {
                      e.target.value = e.target.value.slice(0, 7);
                    }
                  }}
                  style={{borderColor:errors.limitsMemory ? 'red' : '#02A7F0'}}
                  {...register(`limitsMemory`, {
                    required: '请输入'
                  })}
                    onChange={(e) => {
                      setCurrentData({
                        ...currentData,
                        limitsMemory: Number(e.target.value)
                      })
                    }}
                    autoFocus={true}
                    maxLength={60}
                  />
                  <InputRightAddon style={{ height: 32, borderColor: '#02A7F0' }}>Gi</InputRightAddon>
                </InputGroup>
              </Flex>
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={handleSubmit(onEditConfirm)}>
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}

export default React.memo(AppList)